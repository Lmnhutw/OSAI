package worker

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"execution-go/internal/artifact"
	"execution-go/internal/cli"
	"execution-go/internal/config"
	"execution-go/internal/jira"
	"execution-go/internal/prompt"
	execresult "execution-go/internal/result"
	"execution-go/internal/runner"
	"execution-go/internal/store"
	"execution-go/internal/workspace"
)

type JiraClient interface {
	SearchReadyIssues(ctx context.Context, maxResults int) ([]jira.Issue, error)
	TransitionIssue(ctx context.Context, issueKey, targetStatus string) error
	AddComment(ctx context.Context, issueKey, body string) error
}

type WorkspaceManager interface {
	Prepare(ctx context.Context, req workspace.PrepareRequest) (workspace.Workspace, []cli.Result, error)
	ChangedFiles(ctx context.Context, workspacePath string) ([]string, cli.Result)
}

type CodexExecutor interface {
	Run(ctx context.Context, req runner.CodexRequest) (cli.Result, string, error)
}

type QualityExecutor interface {
	RunAll(ctx context.Context, workspacePath string, lintCommands, testCommands []string) []cli.Result
}

type ArtifactWriter interface {
	Write(ctx context.Context, report artifact.Report) (artifact.Artifact, error)
}

type Service struct {
	cfg       config.Config
	logger    *slog.Logger
	jira      JiraClient
	store     store.TaskStore
	workspace WorkspaceManager
	codex     CodexExecutor
	quality   QualityExecutor
	artifact  ArtifactWriter
}

func NewService(
	cfg config.Config,
	logger *slog.Logger,
	jira JiraClient,
	taskStore store.TaskStore,
	workspace WorkspaceManager,
	codex CodexExecutor,
	quality QualityExecutor,
	artifactWriter ArtifactWriter,
) *Service {
	if logger == nil {
		logger = slog.Default()
	}

	return &Service{
		cfg:       cfg,
		logger:    logger,
		jira:      jira,
		store:     taskStore,
		workspace: workspace,
		codex:     codex,
		quality:   quality,
		artifact:  artifactWriter,
	}
}

func (s *Service) Run(ctx context.Context) error {
	interval := s.cfg.PollInterval
	if interval <= 0 {
		interval = 30 * time.Second
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	sem := make(chan struct{}, s.cfg.MaxConcurrent)
	var wg sync.WaitGroup
	defer wg.Wait()

	s.dispatch(ctx, sem, &wg)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			s.dispatch(ctx, sem, &wg)
		}
	}
}

func (s *Service) dispatch(ctx context.Context, sem chan struct{}, wg *sync.WaitGroup) {
	pollCtx, cancel := context.WithTimeout(ctx, s.cfg.JiraRequestTimeout)
	defer cancel()

	issues, err := s.jira.SearchReadyIssues(pollCtx, s.cfg.JiraPollPageSize)
	if err != nil {
		s.logger.Error("failed to poll jira", "error", err)
		return
	}

	for _, issue := range issues {
		select {
		case sem <- struct{}{}:
		default:
			return
		}

		claimCtx, claimCancel := context.WithTimeout(ctx, s.cfg.ClaimTimeout)
		claimed, err := s.store.ClaimReadyTask(claimCtx, issue.Key, s.cfg.WorkerName)
		claimCancel()
		if err != nil {
			<-sem
			s.logger.Error("failed to claim task", "issue", issue.Key, "error", err)
			continue
		}
		if claimed == nil {
			<-sem
			continue
		}

		wg.Add(1)
		go func(issue jira.Issue, claimed *store.ClaimedTask) {
			defer wg.Done()
			defer func() { <-sem }()

			taskCtx, cancel := context.WithTimeout(ctx, s.cfg.TaskTimeout)
			defer cancel()

			if err := s.executeClaimedTask(taskCtx, issue, claimed); err != nil {
				s.logger.Error("task execution ended with error", "task_id", claimed.Task.ID, "issue", issue.Key, "error", err)
			}
		}(issue, claimed)
	}
}

func (s *Service) executeClaimedTask(ctx context.Context, issue jira.Issue, claimed *store.ClaimedTask) error {
	spec := BuildExecutionSpec(s.cfg, issue, claimed.Task)

	results := []string{
		fmt.Sprintf("Claimed task %s for Jira issue %s.", claimed.Task.ID, issue.Key),
	}
	findings := make([]string, 0, 8)
	decisions := []string{
		"Worker: " + s.cfg.WorkerName,
		"Repository source: " + spec.RepoSource,
		"Base branch: " + spec.BaseBranch,
		"Execution branch: " + spec.BranchName,
	}
	commands := make([]cli.Result, 0, 16)

	_ = s.tryTransition(ctx, issue.Key, s.cfg.JiraInProgressStatus, &findings)

	if len(spec.LintCommands) == 0 && len(spec.TestCommands) == 0 {
		errMessage := "No lint/test commands were configured for this task."
		findings = append(findings, errMessage)
		return s.finalizeTerminal(
			ctx,
			issue,
			claimed,
			spec,
			claimed.RunID,
			commands,
			results,
			findings,
			decisions,
			nil,
			nil,
			execresult.StatusFailed,
			execresult.FailureClassificationConfigurationError,
			errMessage,
			execresult.ValidationSummary{},
			nil,
			nil,
		)
	}

	ws, workspaceCommands, err := s.workspace.Prepare(ctx, workspace.PrepareRequest{
		TaskID:     spec.TaskID,
		IssueKey:   spec.JiraIssueKey,
		Goal:       spec.Goal,
		RepoSource: spec.RepoSource,
		BaseBranch: spec.BaseBranch,
		BranchName: spec.BranchName,
	})
	commands = append(commands, workspaceCommands...)
	if err != nil {
		errMessage := "Workspace preparation failed: " + err.Error()
		findings = append(findings, errMessage)
		return s.finalizeTerminal(
			ctx,
			issue,
			claimed,
			spec,
			claimed.RunID,
			commands,
			results,
			findings,
			decisions,
			nil,
			nil,
			execresult.StatusFailed,
			execresult.FailureClassificationWorkspaceFailure,
			errMessage,
			execresult.ValidationSummary{},
			nil,
			nil,
		)
	}

	decisions = append(decisions, "Workspace path: "+ws.Path)
	results = append(results, "Workspace prepared successfully.")

	execDir := ws.Path
	if strings.TrimSpace(spec.WorkingDirectory) != "" && spec.WorkingDirectory != "." {
		execDir = filepath.Join(ws.Path, spec.WorkingDirectory)
		decisions = append(decisions, "Codex/test working directory: "+execDir)
	}

	currentRunID := claimed.RunID
	currentAttempt := claimed.AttemptNo
	var lastPromptFile string
	retryContext := make([]string, 0, 8)
	var changedFiles []string
	attempts := make([]attemptOutcome, 0, s.cfg.MaxAttempts)
	failureFingerprints := make(map[string]int, s.cfg.MaxAttempts)
	terminalStatus := execresult.StatusSucceeded
	terminalFailureReason := ""
	terminalFailureClassification := execresult.FailureClassificationNone
	terminalValidation := execresult.ValidationSummary{}
	terminalAnomalies := make([]string, 0, 4)

	for {
		promptText := prompt.Build(prompt.Input{
			TaskID:                  spec.TaskID,
			JiraIssueKey:            spec.JiraIssueKey,
			Title:                   spec.Title,
			Goal:                    spec.Goal,
			Instructions:            spec.Instructions,
			WorkingDirectory:        spec.WorkingDirectory,
			BranchName:              spec.BranchName,
			AcceptanceCriteria:      spec.AcceptanceCriteria,
			AllowedPaths:            spec.AllowedPaths,
			AdditionalInstructions:  spec.AdditionalInstructions,
			PreviousAttemptFindings: retryContext,
		})

		codexResult, promptFile, runErr := s.codex.Run(ctx, runner.CodexRequest{
			WorkspacePath: execDir,
			TaskID:        spec.TaskID,
			BranchName:    spec.BranchName,
			Goal:          spec.Goal,
			Prompt:        promptText,
			AttemptNo:     currentAttempt,
		})
		lastPromptFile = promptFile
		if promptFile != "" {
			decisions = append(decisions, fmt.Sprintf("Attempt %d prompt file: %s", currentAttempt, promptFile))
		}
		if strings.TrimSpace(codexResult.CommandLine) != "" {
			commands = append(commands, codexResult)
		}

		qualityResults := s.quality.RunAll(ctx, execDir, spec.LintCommands, spec.TestCommands)
		commands = append(commands, qualityResults...)
		outcome := summarizeAttemptOutcome(currentAttempt, s.cfg.MaxAttempts, codexResult, runErr, qualityResults, failureFingerprints)
		attempts = append(attempts, outcome)
		terminalStatus = outcome.Status
		terminalValidation = outcome.Validation
		terminalFailureReason = outcome.FailureReason
		terminalFailureClassification = outcome.FailureClassification
		terminalAnomalies = dedupe(append(terminalAnomalies, outcome.Anomalies...))

		if outcome.FailureFingerprint != "" {
			failureFingerprints[outcome.FailureFingerprint]++
		}

		if outcome.FailureReason == "" {
			results = append(results, fmt.Sprintf("Attempt %d succeeded.", currentAttempt))
			break
		}

		findings = append(findings, outcome.FailureReason)
		findings = append(findings, outcome.Anomalies...)
		results = append(results, outcome.Summary)
		retryContext = append(retryContext, outcome.FailureReason)

		if outcome.RepeatedFailurePattern {
			decisions = append(decisions, fmt.Sprintf("Stopped automatic retries after attempt %d because the failure pattern repeated.", currentAttempt))
		}

		if !outcome.RetryEligible {
			break
		}

		intermediateResult := buildTerminalExecutionResult(
			spec,
			outcome.Status,
			outcome.FailureClassification,
			outcome.FailureReason,
			outcome.Validation,
			attempts,
			outcome.Anomalies,
			nil,
			lastPromptFile,
			s.cfg.MaxAttempts,
		)
		intermediateResult.Evaluation = execresult.EvaluationHandoff{
			Ready:               false,
			State:               "retry_scheduled",
			FinalOutcomeDecided: false,
		}
		intermediateResult.Retry.Eligible = true
		intermediateResult.Retry.Remaining = max(0, s.cfg.MaxAttempts-currentAttempt)
		intermediateResult.Retry.MaxAttempts = s.cfg.MaxAttempts

		if err := s.store.FinalizeRun(ctx, store.FinalizeRunInput{
			PlanID:        claimed.Task.PlanID,
			TaskID:        claimed.Task.ID,
			SessionID:     claimed.SessionID,
			RunID:         currentRunID,
			RunStatus:     string(outcome.Status),
			OutputPayload: buildIntermediateRunPayload(intermediateResult, spec.JiraIssueKey),
			ErrorMessage:  outcome.FailureReason,
			EventType:     "execution_run_retryable_failure",
			EventPayload: map[string]any{
				"attempt_no":       currentAttempt,
				"execution_result": intermediateResult,
			},
		}); err != nil {
			return fmt.Errorf("record failed attempt %d: %w", currentAttempt, err)
		}

		retryRun, err := s.store.StartRetryRun(ctx, claimed.Task.PlanID, claimed.Task.ID, claimed.SessionID, claimed.WorkerName, claimed.Task.InputPayload)
		if err != nil {
			findings = append(findings, "Retry allocation failed: "+err.Error())
			terminalFailureReason = strings.TrimSpace(terminalFailureReason + "; retry allocation failed: " + err.Error())
			terminalStatus = execresult.StatusFailed
			break
		}

		currentRunID = retryRun.RunID
		currentAttempt = retryRun.AttemptNo
		results = append(results, fmt.Sprintf("Retry attempt %d started.", currentAttempt))
	}

	changedFilesResultFiles, changedFilesResult := s.workspace.ChangedFiles(ctx, ws.Path)
	if changedFilesResult.CommandLine != "" {
		commands = append(commands, changedFilesResult)
	}
	if changedFilesResult.Success() {
		changedFiles = changedFilesResultFiles
	} else if changedFilesResult.CommandLine != "" {
		message := "Failed to collect changed files: " + summarizeCommandFailure(changedFilesResult)
		findings = append(findings, message)
		terminalAnomalies = append(terminalAnomalies, "changed_files_collection_failed")
	}

	if terminalStatus == execresult.StatusSucceeded && len(changedFiles) == 0 {
		terminalAnomalies = append(terminalAnomalies, "no_tracked_file_changes")
	}
	terminalAnomalies = dedupe(terminalAnomalies)

	if terminalFailureReason == "" {
		results = append(results, "Codex completed successfully and all validation commands passed.")
	} else {
		results = append(results, "Execution completed and is ready for result evaluation.")
	}

	return s.finalizeTerminal(
		ctx,
		issue,
		claimed,
		spec,
		currentRunID,
		commands,
		results,
		findings,
		decisions,
		changedFiles,
		&lastPromptFile,
		terminalStatus,
		terminalFailureClassification,
		terminalFailureReason,
		terminalValidation,
		attempts,
		terminalAnomalies,
	)
}

func (s *Service) finalizeTerminal(
	ctx context.Context,
	issue jira.Issue,
	claimed *store.ClaimedTask,
	spec ExecutionSpec,
	runID string,
	commands []cli.Result,
	results []string,
	findings []string,
	decisions []string,
	changedFiles []string,
	promptFile *string,
	status execresult.Status,
	failureClassification execresult.FailureClassification,
	failureReason string,
	validation execresult.ValidationSummary,
	attempts []attemptOutcome,
	anomalies []string,
) error {
	promptPath := ""
	if promptFile != nil {
		promptPath = strings.TrimSpace(*promptFile)
	}

	preArtifactResult := buildTerminalExecutionResult(
		spec,
		status,
		failureClassification,
		failureReason,
		validation,
		attempts,
		anomalies,
		changedFiles,
		promptPath,
		s.cfg.MaxAttempts,
	)

	if err := s.tryComment(ctx, issue.Key, buildJiraComment(preArtifactResult)); err != nil {
		findings = append(findings, "Failed to add Jira execution comment: "+err.Error())
		anomalies = append(anomalies, "jira_comment_failed")
	}

	if err := s.tryTransition(ctx, issue.Key, s.cfg.JiraEvaluationStatus, &findings); err != nil {
		anomalies = append(anomalies, "jira_transition_failed")
	}

	finalResult := buildTerminalExecutionResult(
		spec,
		status,
		failureClassification,
		failureReason,
		validation,
		attempts,
		anomalies,
		changedFiles,
		promptPath,
		s.cfg.MaxAttempts,
	)
	results = append(results, finalResult.Summary)

	artifactRecord, err := s.writeArtifact(ctx, issue, spec, commands, results, findings, decisions, changedFiles, finalResult)
	if err != nil {
		s.logger.Error("failed to write artifact", "task_id", claimed.Task.ID, "error", err)
		findings = append(findings, "Artifact write failed: "+err.Error())
		anomalies = append(anomalies, "artifact_write_failed")
		if finalResult.Status == execresult.StatusSucceeded {
			finalResult.Status = execresult.StatusPartialSuccess
		}
		finalResult = buildTerminalExecutionResult(
			spec,
			finalResult.Status,
			failureClassification,
			failureReason,
			validation,
			attempts,
			anomalies,
			changedFiles,
			promptPath,
			s.cfg.MaxAttempts,
		)
	} else {
		finalResult.ArtifactPath = artifactRecord.RelativePath
	}

	errorMessage := ""
	if finalResult.HasFailure() {
		errorMessage = finalResult.FailureReason
	}

	if err := s.store.FinalizeRun(ctx, store.FinalizeRunInput{
		PlanID:          claimed.Task.PlanID,
		TaskID:          claimed.Task.ID,
		SessionID:       claimed.SessionID,
		RunID:           runID,
		RunStatus:       string(finalResult.Status),
		SessionStatus:   evaluationReadyState,
		TaskStatus:      evaluationReadyState,
		ArtifactPath:    finalResult.ArtifactPath,
		OutputPayload:   buildTerminalRunPayload(finalResult),
		SessionMetadata: buildSessionMetadata(finalResult),
		ErrorMessage:    errorMessage,
		EventType:       evaluationReadyEventType,
		EventPayload: map[string]any{
			"status":           string(finalResult.Status),
			"jira_issue_key":   finalResult.JiraIssueKey,
			"artifact_path":    finalResult.ArtifactPath,
			"files_changed":    finalResult.FilesChanged,
			"execution_result": finalResult,
		},
	}); err != nil {
		return fmt.Errorf("finalize execution result: %w", err)
	}

	return nil
}

func (s *Service) writeArtifact(
	ctx context.Context,
	issue jira.Issue,
	spec ExecutionSpec,
	commands []cli.Result,
	results []string,
	findings []string,
	decisions []string,
	changedFiles []string,
	executionResult execresult.ExecutionResult,
) (artifact.Artifact, error) {
	return s.artifact.Write(ctx, artifact.Report{
		TaskID:             spec.TaskID,
		JiraIssueKey:       issue.Key,
		Goal:               spec.Goal,
		AcceptanceCriteria: spec.AcceptanceCriteria,
		Execution:          &executionResult,
		FilesChanged:       changedFiles,
		Commands:           commands,
		Results:            dedupe(results),
		Findings:           dedupe(findings),
		Decisions:          dedupe(decisions),
	})
}

func (s *Service) tryTransition(ctx context.Context, issueKey, targetStatus string, findings *[]string) error {
	if strings.TrimSpace(targetStatus) == "" {
		return nil
	}

	transitionCtx, cancel := context.WithTimeout(ctx, s.cfg.JiraRequestTimeout)
	defer cancel()

	if err := s.jira.TransitionIssue(transitionCtx, issueKey, targetStatus); err != nil {
		s.logger.Warn("failed to transition jira issue", "issue", issueKey, "target_status", targetStatus, "error", err)
		if findings != nil {
			*findings = append(*findings, fmt.Sprintf("Failed to transition Jira issue %s to %s: %v", issueKey, targetStatus, err))
		}
		return err
	}
	return nil
}

func (s *Service) tryComment(ctx context.Context, issueKey, body string) error {
	body = strings.TrimSpace(body)
	if body == "" {
		return nil
	}

	commentCtx, cancel := context.WithTimeout(ctx, s.cfg.JiraRequestTimeout)
	defer cancel()

	return s.jira.AddComment(commentCtx, issueKey, body)
}

func buildJiraComment(result execresult.ExecutionResult) string {
	lines := []string{
		"Execution update",
		fmt.Sprintf("Summary: %s", result.Summary),
		fmt.Sprintf("Status: %s", result.Status),
		fmt.Sprintf("Confidence: %s (%.2f)", result.Confidence.Level, result.Confidence.Score),
		fmt.Sprintf("Validation: %d/%d commands passed, %d/%d tests passed", result.Validation.Passed, result.Validation.Total, result.Validation.TestPassed, result.Validation.TestTotal),
	}

	if len(result.FilesChanged) > 0 {
		lines = append(lines, "Files changed:")
		for _, path := range result.FilesChanged {
			lines = append(lines, "- "+path)
		}
	}

	if strings.TrimSpace(result.FailureReason) != "" {
		lines = append(lines, "Failure reason: "+result.FailureReason)
	}

	if len(result.DetectedAnomalies) > 0 {
		lines = append(lines, "Detected anomalies: "+strings.Join(result.DetectedAnomalies, ", "))
	}

	lines = append(lines, "Execution is ready for result evaluation.")
	return strings.Join(lines, "\n")
}

func summarizeCommandFailure(result cli.Result) string {
	if result.TimedOut {
		return fmt.Sprintf("%s timed out after %s", result.Label, result.Duration)
	}

	message := strings.TrimSpace(result.Stderr)
	if message == "" {
		message = strings.TrimSpace(result.Stdout)
	}
	if message == "" {
		message = strings.TrimSpace(result.Error)
	}
	if message == "" {
		message = "command failed without output"
	}

	return fmt.Sprintf("%s failed with exit code %d: %s", result.Label, result.ExitCode, message)
}

func dedupe(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}
