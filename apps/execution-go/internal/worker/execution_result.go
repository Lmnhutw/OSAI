package worker

import (
	"fmt"
	"math"
	"strings"
	"time"

	"execution-go/internal/cli"
	execresult "execution-go/internal/result"
)

const (
	evaluationReadyState     = "evaluation_ready"
	evaluationReadyEventType = "execution_result.ready_for_evaluation"
)

type attemptOutcome struct {
	AttemptNo              int
	RetryCount             int
	Status                 execresult.Status
	Summary                string
	FailureReason          string
	FailureClassification  execresult.FailureClassification
	Validation             execresult.ValidationSummary
	Confidence             execresult.Confidence
	Anomalies              []string
	RetrySuggestions       []string
	RootCauseHints         []string
	RetryEligible          bool
	FailureFingerprint     string
	RepeatedFailurePattern bool
	CodexSucceeded         bool
}

func summarizeAttemptOutcome(
	attemptNo int,
	retryCount int,
	maxAttempts int,
	codexResult cli.Result,
	runErr error,
	qualityResults []cli.Result,
	seenFingerprints map[string]int,
) attemptOutcome {
	validation := summarizeValidation(qualityResults)
	failures := make([]string, 0, 1+validation.Failed)
	codexSucceeded := runErr == nil && codexResult.Success()

	switch {
	case runErr != nil:
		failures = append(failures, fmt.Sprintf("Codex runner failed: %v", runErr))
	case !codexResult.Success():
		failures = append(failures, summarizeCommandFailure(codexResult))
	}

	for _, result := range qualityResults {
		if !result.Success() {
			failures = append(failures, summarizeCommandFailure(result))
		}
	}

	outcome := attemptOutcome{
		AttemptNo:      attemptNo,
		RetryCount:     max(retryCount, 0),
		Status:         execresult.StatusSucceeded,
		Validation:     validation,
		CodexSucceeded: codexSucceeded,
	}

	if len(failures) == 0 {
		outcome.Summary = fmt.Sprintf("Attempt %d completed successfully.", attemptNo)
		outcome.Confidence = deriveConfidence(outcome.Status, codexSucceeded, validation, nil)
		return outcome
	}

	outcome.FailureReason = strings.Join(failures, "; ")
	outcome.FailureClassification = classifyFailure(runErr, codexResult, validation)
	outcome.FailureFingerprint = buildFailureFingerprint(outcome.FailureClassification, codexResult, runErr, validation)
	outcome.RetrySuggestions = retrySuggestionsFor(outcome.FailureClassification)
	outcome.RootCauseHints = detectRootCauseHints(outcome.FailureClassification, codexResult, runErr, validation)

	if outcome.FailureFingerprint != "" && seenFingerprints[outcome.FailureFingerprint] > 0 {
		outcome.RepeatedFailurePattern = true
		outcome.Anomalies = append(outcome.Anomalies, "repeated_failure_pattern")
		outcome.RootCauseHints = append(outcome.RootCauseHints, "The current failure fingerprint matches a previous execution failure.")
	}

	remaining := maxAttempts - attemptNo
	outcome.RetryEligible = remaining > 0 &&
		!outcome.RepeatedFailurePattern &&
		outcome.FailureClassification != execresult.FailureClassificationConfigurationError &&
		outcome.FailureClassification != execresult.FailureClassificationWorkspaceFailure &&
		outcome.FailureClassification != execresult.FailureClassificationArtifactFailure

	if outcome.RetryEligible {
		outcome.Status = execresult.StatusRetryableFailure
		outcome.Summary = fmt.Sprintf("Attempt %d failed but can be retried safely.", attemptNo)
	} else {
		switch outcome.FailureClassification {
		case execresult.FailureClassificationValidationFailure:
			outcome.Status = execresult.StatusValidationFailed
			outcome.Summary = fmt.Sprintf("Attempt %d failed validation checks.", attemptNo)
		default:
			outcome.Status = execresult.StatusFailed
			outcome.Summary = fmt.Sprintf("Attempt %d ended in a terminal failure.", attemptNo)
		}
	}

	outcome.RootCauseHints = dedupe(outcome.RootCauseHints)
	outcome.Confidence = deriveConfidence(outcome.Status, codexSucceeded, validation, outcome.Anomalies)
	return outcome
}

func summarizeValidation(results []cli.Result) execresult.ValidationSummary {
	summary := execresult.ValidationSummary{
		Commands: make([]execresult.CommandSummary, 0, len(results)),
	}

	for _, result := range results {
		kind := "validation"
		switch {
		case strings.HasPrefix(result.Label, "lint"):
			kind = "lint"
			summary.LintTotal++
		case strings.HasPrefix(result.Label, "test"):
			kind = "test"
			summary.TestTotal++
		}

		commandSummary := execresult.CommandSummary{
			Label:    result.Label,
			Kind:     kind,
			Command:  strings.TrimSpace(result.CommandLine),
			Passed:   result.Success(),
			ExitCode: result.ExitCode,
			TimedOut: result.TimedOut,
			Duration: result.Duration.String(),
		}

		if !result.Success() {
			commandSummary.ErrorHint = summarizeCommandFailure(result)
			summary.Failed++
			switch kind {
			case "lint":
				summary.LintFailed++
			case "test":
				summary.TestFailed++
			}
		} else {
			summary.Passed++
			switch kind {
			case "lint":
				summary.LintPassed++
			case "test":
				summary.TestPassed++
			}
		}

		summary.Total++
		summary.Commands = append(summary.Commands, commandSummary)
	}

	return summary
}

func classifyFailure(runErr error, codexResult cli.Result, validation execresult.ValidationSummary) execresult.FailureClassification {
	switch {
	case validation.Failed > 0:
		return execresult.FailureClassificationValidationFailure
	case runErr != nil || !codexResult.Success():
		return execresult.FailureClassificationCodexExecutionFailed
	default:
		return execresult.FailureClassificationUnknown
	}
}

func buildFailureFingerprint(
	classification execresult.FailureClassification,
	codexResult cli.Result,
	runErr error,
	validation execresult.ValidationSummary,
) string {
	parts := []string{string(classification)}
	if runErr != nil {
		parts = append(parts, normalizeFingerprint(runErr.Error()))
	}
	if !codexResult.Success() {
		parts = append(parts, codexResult.Label, normalizeFingerprint(codexResult.Stderr), normalizeFingerprint(codexResult.Error))
	}
	for _, command := range validation.Commands {
		if !command.Passed {
			parts = append(parts, command.Kind, command.Label, normalizeFingerprint(command.ErrorHint))
		}
	}

	filtered := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		filtered = append(filtered, part)
	}
	return strings.Join(filtered, "|")
}

func normalizeFingerprint(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.NewReplacer("\r", " ", "\n", " ", "\t", " ").Replace(value)
	for strings.Contains(value, "  ") {
		value = strings.ReplaceAll(value, "  ", " ")
	}
	if len(value) > 160 {
		value = value[:160]
	}
	return value
}

func retrySuggestionsFor(classification execresult.FailureClassification) []string {
	switch classification {
	case execresult.FailureClassificationConfigurationError:
		return []string{
			"Add or correct lint and test commands before retrying this task.",
			"Keep the next run narrow so validation evidence is produced deterministically.",
		}
	case execresult.FailureClassificationWorkspaceFailure:
		return []string{
			"Verify the repository source, base branch, and git access before retrying.",
			"Retry only after the workspace can be prepared cleanly.",
		}
	case execresult.FailureClassificationCodexExecutionFailed:
		return []string{
			"Inspect the Codex stderr output and prompt file before retrying.",
			"Reduce scope or tighten instructions if the same execution error repeats.",
		}
	case execresult.FailureClassificationValidationFailure:
		return []string{
			"Focus the next retry on the failing lint or test commands only.",
			"Preserve passing checks and attach the failing command output to the next prompt.",
		}
	case execresult.FailureClassificationRepeatedPattern:
		return []string{
			"Stop automatic retries and escalate to an operator with the artifact and prompt file.",
			"Create a narrowed follow-up task instead of repeating the same execution path.",
		}
	default:
		return []string{
			"Review the stored execution output before retrying automatically.",
		}
	}
}

func detectRootCauseHints(
	classification execresult.FailureClassification,
	codexResult cli.Result,
	runErr error,
	validation execresult.ValidationSummary,
) []string {
	hints := make([]string, 0, 4)

	switch classification {
	case execresult.FailureClassificationValidationFailure:
		hints = append(hints, "One or more validation commands failed after the implementation step.")
	case execresult.FailureClassificationCodexExecutionFailed:
		hints = append(hints, "The Codex execution step did not finish cleanly before validation succeeded.")
	}

	if runErr != nil {
		hints = append(hints, firstSentence(runErr.Error()))
	}
	if codexResult.TimedOut {
		hints = append(hints, "The Codex command timed out before finishing.")
	}
	if !codexResult.Success() {
		hints = append(hints, firstSentence(firstNonEmpty(codexResult.Stderr, codexResult.Error, codexResult.Stdout)))
	}

	for _, command := range validation.Commands {
		if command.Passed {
			continue
		}
		switch command.Kind {
		case "test":
			hints = append(hints, fmt.Sprintf("Test validation failed in %s.", command.Label))
		case "lint":
			hints = append(hints, fmt.Sprintf("Lint validation failed in %s.", command.Label))
		default:
			hints = append(hints, fmt.Sprintf("Validation failed in %s.", command.Label))
		}
		if snippet := firstSentence(command.ErrorHint); snippet != "" {
			hints = append(hints, snippet)
		}
	}

	if validation.Passed > 0 && validation.Failed > 0 {
		hints = append(hints, "Some validation passed, which suggests the implementation is partially complete.")
	}

	return dedupe(hints)
}

func deriveConfidence(
	status execresult.Status,
	codexSucceeded bool,
	validation execresult.ValidationSummary,
	anomalies []string,
) execresult.Confidence {
	score := 0.15
	signals := make([]string, 0, 4)

	if codexSucceeded {
		score += 0.25
		signals = append(signals, "Codex execution completed.")
	} else {
		signals = append(signals, "Codex execution did not complete cleanly.")
	}

	if validation.Total > 0 {
		passRatio := float64(validation.Passed) / float64(validation.Total)
		score += 0.45 * passRatio
		if validation.Failed == 0 {
			signals = append(signals, "All validation commands passed.")
		} else {
			signals = append(signals, fmt.Sprintf("%d of %d validation commands passed.", validation.Passed, validation.Total))
		}
	} else {
		signals = append(signals, "No validation commands were recorded.")
	}

	if len(anomalies) == 0 {
		score += 0.1
	} else {
		score -= 0.05 * float64(min(len(anomalies), 3))
		signals = append(signals, fmt.Sprintf("%d anomaly signal(s) were detected.", len(anomalies)))
	}

	switch status {
	case execresult.StatusRetryableFailure, execresult.StatusValidationFailed, execresult.StatusFailed:
		score -= 0.2
	case execresult.StatusPartialSuccess:
		score -= 0.05
	}

	score = math.Max(0.05, math.Min(0.95, score))

	level := execresult.ConfidenceLow
	switch {
	case score >= 0.75:
		level = execresult.ConfidenceHigh
	case score >= 0.45:
		level = execresult.ConfidenceMedium
	}

	return execresult.Confidence{
		Score:   math.Round(score*100) / 100,
		Level:   level,
		Signals: signals,
	}
}

func buildTerminalExecutionResult(
	spec ExecutionSpec,
	status execresult.Status,
	failureClassification execresult.FailureClassification,
	failureReason string,
	validation execresult.ValidationSummary,
	attempts []attemptOutcome,
	anomalies []string,
	changedFiles []string,
	promptFile string,
	maxAttempts int,
	branchStrategy string,
	workspaceCleaned bool,
) execresult.ExecutionResult {
	attemptCount := len(attempts)
	if attemptCount == 0 {
		attemptCount = 1
	}

	lastAttempt := attemptOutcome{
		RetryCount:     spec.RetryCount,
		CodexSucceeded: status == execresult.StatusSucceeded || status == execresult.StatusPartialSuccess,
		Validation:     validation,
	}
	if len(attempts) > 0 {
		lastAttempt = attempts[len(attempts)-1]
	}

	retry := execresult.RetryGuidance{
		Eligible:               false,
		Remaining:              0,
		MaxAttempts:            max(1, maxAttempts),
		RepeatedFailurePattern: lastAttempt.RepeatedFailurePattern,
		FailureFingerprint:     lastAttempt.FailureFingerprint,
		Suggestions:            append([]string(nil), lastAttempt.RetrySuggestions...),
	}
	if retry.RepeatedFailurePattern {
		retry.Reason = "Automatic retries stopped because the same failure pattern repeated."
		if failureClassification == execresult.FailureClassificationNone {
			failureClassification = execresult.FailureClassificationRepeatedPattern
		}
	} else if strings.TrimSpace(failureReason) != "" {
		retry.Reason = "Automatic retries are complete for this task."
	}

	anomalies = dedupe(anomalies)
	if status == execresult.StatusSucceeded && len(anomalies) > 0 {
		status = execresult.StatusPartialSuccess
	}
	if qualifiesForPartialSuccess(status, failureClassification, changedFiles) {
		status = execresult.StatusPartialSuccess
	}

	validation = ensureValidationSummary(validation)
	rootCauseHints := dedupe(append([]string(nil), lastAttempt.RootCauseHints...))
	if strings.TrimSpace(failureReason) != "" && len(changedFiles) == 0 {
		rootCauseHints = append(rootCauseHints, "No tracked repository changes were detected before the run exited.")
	}
	if !workspaceCleaned {
		rootCauseHints = append(rootCauseHints, "Workspace cleanup did not complete cleanly after execution.")
	}
	if spec.RetryCount > 0 && strings.TrimSpace(spec.FailurePatternHint) != "" && spec.FailurePatternHint == lastAttempt.FailureFingerprint {
		rootCauseHints = append(rootCauseHints, "The current failure fingerprint matches the previously recorded failure pattern hint.")
	}
	rootCauseHints = dedupe(rootCauseHints)

	partial := buildPartialExecution(status, failureClassification, failureReason, changedFiles, anomalies)
	confidence := deriveConfidence(status, lastAttempt.CodexSucceeded, validation, anomalies)
	history := buildAttemptHistory(attempts)
	failurePatternHint := strings.TrimSpace(firstNonEmpty(lastAttempt.FailureFingerprint, spec.FailurePatternHint))
	retrySuggestions := dedupe(append([]string(nil), retry.Suggestions...))

	return execresult.ExecutionResult{
		Status:                status,
		Summary:               buildExecutionSummary(status, attemptCount, validation, changedFiles, len(anomalies), spec.ExecutionIndex, lastAttempt.RetryCount),
		ReasoningSummary:      buildReasoningSummary(spec, status, attempts, validation, changedFiles, anomalies, partial),
		FailureReason:         strings.TrimSpace(failureReason),
		FailureClassification: failureClassification,
		FailureType:           failureClassification,
		RetrySuggestions:      retrySuggestions,
		RootCauseHints:        rootCauseHints,
		Partial:               partial,
		Confidence:            confidence,
		DetectedAnomalies:     anomalies,
		Retry:                 retry,
		Validation:            validation,
		FilesChanged:          append([]string(nil), changedFiles...),
		PromptFile:            strings.TrimSpace(promptFile),
		JiraIssueKey:          spec.JiraIssueKey,
		AttemptCount:          attemptCount,
		Metadata: execresult.ExecutionMetadata{
			RunID:              spec.RunID,
			ExecutionIndex:     max(1, spec.ExecutionIndex),
			RetryCount:         max(lastAttempt.RetryCount, spec.RetryCount),
			FailurePatternHint: failurePatternHint,
			BranchName:         spec.BranchName,
			BranchStrategy:     strings.TrimSpace(branchStrategy),
			WorkspaceCleaned:   workspaceCleaned,
		},
		History: history,
		Evaluation: execresult.EvaluationHandoff{
			Ready:               true,
			State:               evaluationReadyState,
			EventType:           evaluationReadyEventType,
			FinalOutcomeDecided: false,
		},
		CompletedAt: time.Now().UTC(),
	}
}

func ensureValidationSummary(summary execresult.ValidationSummary) execresult.ValidationSummary {
	if summary.Commands == nil {
		summary.Commands = []execresult.CommandSummary{}
	}
	return summary
}

func qualifiesForPartialSuccess(
	status execresult.Status,
	failureClassification execresult.FailureClassification,
	changedFiles []string,
) bool {
	if len(changedFiles) == 0 {
		return false
	}
	if status != execresult.StatusValidationFailed && status != execresult.StatusFailed {
		return false
	}
	return failureClassification == execresult.FailureClassificationValidationFailure ||
		failureClassification == execresult.FailureClassificationCodexExecutionFailed ||
		failureClassification == execresult.FailureClassificationArtifactFailure
}

func buildPartialExecution(
	status execresult.Status,
	failureClassification execresult.FailureClassification,
	failureReason string,
	changedFiles []string,
	anomalies []string,
) execresult.PartialExecution {
	partial := execresult.PartialExecution{}

	switch failureClassification {
	case execresult.FailureClassificationConfigurationError:
		partial.EarlyExit = true
		partial.ReasonCode = "configuration_blocked"
	case execresult.FailureClassificationWorkspaceFailure:
		partial.EarlyExit = true
		partial.ReasonCode = "workspace_preparation_failed"
	case execresult.FailureClassificationArtifactFailure:
		partial.ReasonCode = "artifact_recording_failed"
	case execresult.FailureClassificationValidationFailure:
		partial.ReasonCode = "validation_failed_after_changes"
	case execresult.FailureClassificationCodexExecutionFailed:
		partial.ReasonCode = "implementation_incomplete"
	}

	if status == execresult.StatusPartialSuccess || status == execresult.StatusValidationFailed || status == execresult.StatusFailed {
		partial.IncompleteImplementation = len(changedFiles) > 0 && strings.TrimSpace(failureReason) != ""
	}
	if partial.ReasonCode == "" && len(anomalies) > 0 {
		partial.ReasonCode = "execution_completed_with_anomalies"
	}
	partial.Reason = strings.TrimSpace(firstNonEmpty(failureReason, strings.Join(anomalies, ", ")))

	return partial
}

func buildAttemptHistory(attempts []attemptOutcome) []execresult.AttemptSummary {
	if len(attempts) == 0 {
		return nil
	}

	history := make([]execresult.AttemptSummary, 0, len(attempts))
	for _, attempt := range attempts {
		history = append(history, execresult.AttemptSummary{
			AttemptNo:              attempt.AttemptNo,
			RetryCount:             attempt.RetryCount,
			Status:                 attempt.Status,
			Summary:                attempt.Summary,
			FailureReason:          attempt.FailureReason,
			FailureType:            attempt.FailureClassification,
			FailureClassification:  attempt.FailureClassification,
			DetectedAnomalies:      dedupe(attempt.Anomalies),
			RetrySuggestions:       dedupe(attempt.RetrySuggestions),
			RootCauseHints:         dedupe(attempt.RootCauseHints),
			FailurePatternHint:     attempt.FailureFingerprint,
			RepeatedFailurePattern: attempt.RepeatedFailurePattern,
			Validation:             ensureValidationSummary(attempt.Validation),
			Confidence:             attempt.Confidence,
		})
	}
	return history
}

func buildExecutionSummary(
	status execresult.Status,
	attemptCount int,
	validation execresult.ValidationSummary,
	changedFiles []string,
	anomalyCount int,
	executionIndex int,
	retryCount int,
) string {
	summary := fmt.Sprintf("Execution %d finished with status %s after %d attempt(s).", max(executionIndex, 1), status, attemptCount)
	if retryCount > 0 {
		summary += fmt.Sprintf(" Retry count at completion: %d.", retryCount)
	}
	if validation.Total > 0 {
		summary += fmt.Sprintf(" Validation passed %d of %d command(s).", validation.Passed, validation.Total)
	}
	if len(changedFiles) > 0 {
		summary += fmt.Sprintf(" %d file(s) changed.", len(changedFiles))
	}
	if anomalyCount > 0 {
		summary += fmt.Sprintf(" %d anomaly signal(s) detected.", anomalyCount)
	}
	return summary
}

func buildReasoningSummary(
	spec ExecutionSpec,
	status execresult.Status,
	attempts []attemptOutcome,
	validation execresult.ValidationSummary,
	changedFiles []string,
	anomalies []string,
	partial execresult.PartialExecution,
) string {
	parts := []string{
		fmt.Sprintf("Prepared execution %d for Jira issue %s on branch %s.", max(1, spec.ExecutionIndex), fallbackString(spec.JiraIssueKey, "unknown"), fallbackString(spec.BranchName, "unknown")),
		fmt.Sprintf("Ran %d attempt(s) and finished in status %s.", max(1, len(attempts)), status),
	}

	if spec.RetryCount > 0 {
		parts = append(parts, fmt.Sprintf("This run started with retry count %d.", spec.RetryCount))
	}
	if validation.Total > 0 {
		parts = append(parts, fmt.Sprintf("Validation passed %d of %d command(s), including %d of %d test command(s).", validation.Passed, validation.Total, validation.TestPassed, validation.TestTotal))
	} else {
		parts = append(parts, "No validation commands were recorded for this execution.")
	}

	if len(changedFiles) > 0 {
		parts = append(parts, fmt.Sprintf("Detected %d changed file(s) in the workspace.", len(changedFiles)))
	} else {
		parts = append(parts, "No tracked file changes were detected after execution.")
	}

	if partial.EarlyExit {
		parts = append(parts, "The worker exited early with a structured reason before reaching a clean completion state.")
	} else if partial.IncompleteImplementation {
		parts = append(parts, "The implementation appears incomplete even though partial work was produced.")
	}
	if len(anomalies) > 0 {
		parts = append(parts, "Anomalies: "+strings.Join(anomalies, ", ")+".")
	}

	return strings.Join(parts, " ")
}

func buildIntermediateRunPayload(result execresult.ExecutionResult, issueKey string) map[string]any {
	return map[string]any{
		"status":               string(result.Status),
		"jira_issue_key":       issueKey,
		"execution_result":     result,
		"evaluation_state":     result.Evaluation.State,
		"ready_for_evaluation": result.Evaluation.Ready,
		"files_changed":        result.FilesChanged,
		"failure_reason":       result.FailureReason,
		"failure_category":     result.FailureClassification,
		"failure_type":         result.FailureType,
		"retry_count":          result.Metadata.RetryCount,
		"execution_index":      result.Metadata.ExecutionIndex,
		"failure_pattern_hint": result.Metadata.FailurePatternHint,
	}
}

func buildTerminalRunPayload(result execresult.ExecutionResult) map[string]any {
	return map[string]any{
		"status":               string(result.Status),
		"jira_issue_key":       result.JiraIssueKey,
		"artifact_path":        result.ArtifactPath,
		"files_changed":        result.FilesChanged,
		"prompt_file":          result.PromptFile,
		"evaluation_state":     result.Evaluation.State,
		"ready_for_evaluation": result.Evaluation.Ready,
		"retry_count":          result.Metadata.RetryCount,
		"execution_index":      result.Metadata.ExecutionIndex,
		"failure_pattern_hint": result.Metadata.FailurePatternHint,
		"execution_result":     result,
	}
}

func buildSessionMetadata(result execresult.ExecutionResult) map[string]any {
	return map[string]any{
		"latest_execution_status": string(result.Status),
		"evaluation_state":        result.Evaluation.State,
		"latest_execution_result": result,
		"last_execution_at":       result.CompletedAt.Format(time.RFC3339),
		"execution_index":         result.Metadata.ExecutionIndex,
		"retry_count":             result.Metadata.RetryCount,
		"failure_pattern_hint":    result.Metadata.FailurePatternHint,
		"execution_history":       result.History,
	}
}

func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func max(left, right int) int {
	if left > right {
		return left
	}
	return right
}

func fallbackString(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return value
}

func firstSentence(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	value = strings.NewReplacer("\r", " ", "\n", " ", "\t", " ").Replace(value)
	if idx := strings.Index(value, ". "); idx > 0 {
		return strings.TrimSpace(value[:idx+1])
	}
	if idx := strings.Index(value, "; "); idx > 0 {
		return strings.TrimSpace(value[:idx])
	}
	if len(value) > 160 {
		return strings.TrimSpace(value[:160])
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			return value
		}
	}
	return ""
}
