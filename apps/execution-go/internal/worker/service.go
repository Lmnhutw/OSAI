package worker

import (
	"context"
	"fmt"
	"log/slog"
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
	Cleanup(ctx context.Context, ws workspace.Workspace) (cli.Result, error)
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
	spec := BuildExecutionSpec(s.cfg, issue, claimed)
	telemetry := make([]execresult.TelemetryEntry, 0, 12)
	safetyChecks := make([]execresult.SafetyCheck, 0, 12)

	s.emitTelemetry(ctx, claimed, spec, &telemetry, "start", "started", map[string]any{
		"jira_issue_key":    spec.JiraIssueKey,
		"execution_index":   spec.ExecutionIndex,
		"retry_count":       spec.RetryCount,
		"execution_mode":    spec.Contract.ExecutionMode,
		"policy_version":    firstNonEmpty(spec.PolicySnapshot.Version, spec.Contract.PolicyVersion),
		"approved":          spec.Contract.Approval.Approved,
		"approval_required": spec.Contract.Approval.Required || spec.PolicySnapshot.ApprovalRequired,
	})

	results := []string{
		fmt.Sprintf("Claimed task %s for Jira issue %s.", claimed.Task.ID, issue.Key),
	}
	findings := make([]string, 0, 10)
	decisions := []string{
		"Worker: " + spec.WorkerID,
		"Repository source: " + spec.RepoSource,
		"Base branch: " + spec.BaseBranch,
		"Execution branch: " + spec.BranchName,
		fmt.Sprintf("Execution index: %d", spec.ExecutionIndex),
		fmt.Sprintf("Retry count: %d", spec.RetryCount),
		"Execution contract: " + firstNonEmpty(spec.Contract.ID, "missing"),
		"Execution mode: " + firstNonEmpty(string(spec.Contract.ExecutionMode), "unspecified"),
	}
	commands := make([]cli.Result, 0, 20)

	if strings.TrimSpace(spec.Contract.PolicyVersion) != "" {
		decisions = append(decisions, "Execution contract policy version: "+spec.Contract.PolicyVersion)
	}
	if strings.TrimSpace(spec.PolicySnapshot.Version) != "" {
		decisions = append(decisions, "Policy snapshot version: "+spec.PolicySnapshot.Version)
	}
	if spec.Contract.Approval.Required || spec.PolicySnapshot.ApprovalRequired {
		decisions = append(decisions, fmt.Sprintf("Approval required: %t", true))
		decisions = append(decisions, fmt.Sprintf("Approval granted: %t", spec.Contract.Approval.Approved))
	}
	if strings.TrimSpace(spec.Contract.AutonomyReasoningRef) != "" {
		decisions = append(decisions, "Autonomy reasoning reference: "+spec.Contract.AutonomyReasoningRef)
	}
	if len(spec.Contract.Write.AllowedPaths) > 0 {
		decisions = append(decisions, "Allowed write paths: "+strings.Join(spec.Contract.Write.AllowedPaths, ", "))
	}
	if strings.TrimSpace(spec.FailurePatternHint) != "" {
		decisions = append(decisions, "Previous failure pattern hint: "+spec.FailurePatternHint)
	}
	if spec.RetryCount > 0 {
		results = append(results, fmt.Sprintf("Retry-aware execution enabled for retry_count=%d.", spec.RetryCount))
		decisions = append(decisions, "Retry-aware validation mode: strict")
	}

	_ = s.tryTransition(ctx, issue.Key, s.cfg.JiraInProgressStatus, &findings)

	contractDecision := validateExecutionContract(spec, s.cfg.MaxAttempts)
	safetyChecks = append(safetyChecks, contractDecision.SafetyChecks...)
	if contractDecision.FailureClassification != execresult.FailureClassificationNone {
		results = append(results, "Execution stopped during policy validation.")
		findings = append(findings, contractDecision.FailureReason)
		s.emitTelemetry(ctx, claimed, spec, &telemetry, "policy_validation", "rejected", map[string]any{
			"classification": contractDecision.FailureClassification,
			"reason":         contractDecision.FailureReason,
		})
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
			contractDecision.FailureClassification,
			contractDecision.FailureReason,
			execresult.ValidationSummary{},
			nil,
			nil,
			"",
			false,
			safetyChecks,
			telemetry,
		)
	}
	s.emitTelemetry(ctx, claimed, spec, &telemetry, "policy_validation", "passed", map[string]any{
		"execution_mode":         contractDecision.Plan.Mode,
		"run_codex":              contractDecision.Plan.RunCodex,
		"run_validation":         contractDecision.Plan.RunValidation,
		"write_enabled":          contractDecision.Plan.WriteEnabled,
		"effective_max_attempts": contractDecision.Plan.EffectiveMaxAttempts,
	})
	results = append(results, "Execution contract validated successfully.")

	if contractDecision.Plan.RunValidation && len(spec.LintCommands) == 0 && len(spec.TestCommands) == 0 {
		errMessage := "No lint/test commands were configured for an execute_with_validation task."
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
			"",
			false,
			safetyChecks,
			telemetry,
		)
	}

	ws, workspaceCommands, err := s.workspace.Prepare(ctx, workspace.PrepareRequest{
		TaskID:         spec.TaskID,
		IssueKey:       spec.JiraIssueKey,
		Goal:           spec.Goal,
		RepoSource:     spec.RepoSource,
		BaseBranch:     spec.BaseBranch,
		BranchName:     spec.BranchName,
		RunID:          spec.RunID,
		ExecutionIndex: spec.ExecutionIndex,
		RetryCount:     spec.RetryCount,
	})
	commands = append(commands, workspaceCommands...)
	if err != nil {
		errMessage := "Workspace preparation failed: " + err.Error()
		findings = append(findings, errMessage)
		s.emitTelemetry(ctx, claimed, spec, &telemetry, "workspace", "failed", map[string]any{
			"reason": errMessage,
		})
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
			"",
			false,
			safetyChecks,
			telemetry,
		)
	}
	s.emitTelemetry(ctx, claimed, spec, &telemetry, "workspace", "prepared", map[string]any{
		"workspace_path":  ws.Path,
		"branch_strategy": ws.BranchStrategy,
	})

	decisions = append(decisions, "Workspace path: "+ws.Path)
	decisions = append(decisions, "Workspace branch strategy: "+ws.BranchStrategy)
	results = append(results, "Workspace prepared successfully.")

	execDir, err := workspace.ResolveWithinRoot(ws.Path, spec.WorkingDirectory)
	if err != nil {
		errMessage := "Working directory validation failed: " + err.Error()
		findings = append(findings, errMessage)
		safetyChecks = append(safetyChecks, failedCheck("working_directory_within_workspace", errMessage))
		s.emitTelemetry(ctx, claimed, spec, &telemetry, "workspace", "invalid_working_directory", map[string]any{
			"reason": errMessage,
		})
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
			execresult.FailureClassificationPolicyRejected,
			errMessage,
			execresult.ValidationSummary{},
			nil,
			nil,
			ws.BranchStrategy,
			false,
			safetyChecks,
			telemetry,
		)
	}
	safetyChecks = append(safetyChecks, passedCheck("working_directory_within_workspace", "Working directory resolved inside the prepared workspace."))
	decisions = append(decisions, "Codex/test working directory: "+execDir)

	currentRunID := claimed.RunID
	currentAttempt := claimed.AttemptNo
	currentRetryCount := max(spec.RetryCount, claimed.RetryCount)
	currentFailurePatternHint := spec.FailurePatternHint
	var lastPromptFile string
	retryContext := make([]string, 0, 8)
	var changedFiles []string
	attempts := make([]attemptOutcome, 0, s.cfg.MaxAttempts)
	failureFingerprints := make(map[string]int, s.cfg.MaxAttempts)
	if strings.TrimSpace(currentFailurePatternHint) != "" {
		failureFingerprints[currentFailurePatternHint] = 1
	}
	terminalStatus := execresult.StatusSucceeded
	terminalFailureReason := ""
	terminalFailureClassification := execresult.FailureClassificationNone
	terminalValidation := execresult.ValidationSummary{}
	terminalAnomalies := make([]string, 0, 6)
	workspaceCleaned := false

	if !contractDecision.Plan.RunCodex {
		if contractDecision.Plan.InspectOnly {
			results = append(results, "inspect_only mode skipped Codex execution and validation.")
		} else if contractDecision.Plan.DryRun {
			results = append(results, "dry-run mode validated policy and workspace setup without running Codex or validation commands.")
		} else {
			results = append(results, "Execution mode completed without a Codex run.")
		}
		s.emitTelemetry(ctx, claimed, spec, &telemetry, "codex", "skipped", map[string]any{
			"execution_mode": contractDecision.Plan.Mode,
			"dry_run":        contractDecision.Plan.DryRun,
		})
		s.emitTelemetry(ctx, claimed, spec, &telemetry, "validation", "skipped", map[string]any{
			"execution_mode": contractDecision.Plan.Mode,
			"dry_run":        contractDecision.Plan.DryRun,
		})
	} else {
		for {
			spec.RunID = currentRunID

			promptText := prompt.Build(prompt.Input{
				TaskID:                  spec.TaskID,
				JiraIssueKey:            spec.JiraIssueKey,
				Title:                   spec.Title,
				Goal:                    spec.Goal,
				ExecutionIndex:          spec.ExecutionIndex,
				RetryCount:              currentRetryCount,
				FailurePatternHint:      currentFailurePatternHint,
				Instructions:            spec.Instructions,
				WorkingDirectory:        spec.WorkingDirectory,
				BranchName:              spec.BranchName,
				AcceptanceCriteria:      spec.AcceptanceCriteria,
				AllowedPaths:            spec.AllowedPaths,
				AdditionalInstructions:  spec.AdditionalInstructions,
				PreviousAttemptFindings: retryContext,
				ExecutionMode:           string(spec.Contract.ExecutionMode),
				ContractActions:         spec.Contract.AllowedActions,
				AutonomyReasoningRef:    spec.Contract.AutonomyReasoningRef,
			})

			codexResult, promptFile, runErr := s.codex.Run(ctx, runner.CodexRequest{
				WorkspacePath:      execDir,
				MetadataPath:       ws.MetadataPath,
				TaskID:             spec.TaskID,
				BranchName:         spec.BranchName,
				Goal:               spec.Goal,
				Prompt:             promptText,
				AttemptNo:          currentAttempt,
				RetryCount:         currentRetryCount,
				ExecutionIndex:     spec.ExecutionIndex,
				FailurePatternHint: currentFailurePatternHint,
			})
			lastPromptFile = promptFile
			if promptFile != "" {
				decisions = append(decisions, fmt.Sprintf("Attempt %d prompt file: %s", currentAttempt, promptFile))
			}
			if strings.TrimSpace(codexResult.CommandLine) != "" {
				commands = append(commands, codexResult)
			}
			s.emitTelemetry(ctx, claimed, spec, &telemetry, "codex", telemetryStatus(runErr == nil && codexResult.Success()), map[string]any{
				"attempt_no": currentAttempt,
				"exit_code":  codexResult.ExitCode,
				"timed_out":  codexResult.TimedOut,
				"error":      summarizeExecutionError(runErr, codexResult),
			})

			var qualityResults []cli.Result
			if contractDecision.Plan.RunValidation {
				qualityResults = s.quality.RunAll(ctx, execDir, spec.LintCommands, spec.TestCommands)
				commands = append(commands, qualityResults...)
				s.emitTelemetry(ctx, claimed, spec, &telemetry, "validation", telemetryStatus(allCommandsSucceeded(qualityResults)), map[string]any{
					"attempt_no": currentAttempt,
					"total":      len(qualityResults),
					"failed":     countFailedCommands(qualityResults),
				})
			}

			outcome := summarizeAttemptOutcome(currentAttempt, currentRetryCount, contractDecision.Plan.EffectiveMaxAttempts, codexResult, runErr, qualityResults, failureFingerprints)
			attempts = append(attempts, outcome)
			terminalStatus = outcome.Status
			terminalValidation = outcome.Validation
			terminalFailureReason = outcome.FailureReason
			terminalFailureClassification = outcome.FailureClassification
			terminalAnomalies = dedupe(append(terminalAnomalies, outcome.Anomalies...))

			if outcome.FailureFingerprint != "" {
				failureFingerprints[outcome.FailureFingerprint]++
				currentFailurePatternHint = outcome.FailureFingerprint
			}

			if outcome.FailureReason == "" {
				results = append(results, fmt.Sprintf("Attempt %d succeeded.", currentAttempt))
				break
			}

			findings = append(findings, outcome.FailureReason)
			findings = append(findings, outcome.RootCauseHints...)
			findings = append(findings, outcome.Anomalies...)
			results = append(results, outcome.Summary)
			retryContext = append(retryContext, outcome.FailureReason)

			if outcome.RepeatedFailurePattern {
				decisions = append(decisions, fmt.Sprintf("Stopped automatic retries after attempt %d because the failure pattern repeated.", currentAttempt))
			}

			if !outcome.RetryEligible {
				break
			}

			spec.RunID = currentRunID
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
				contractDecision.Plan.EffectiveMaxAttempts,
				ws.BranchStrategy,
				false,
				safetyChecks,
				telemetry,
			)
			intermediateResult.Evaluation = execresult.EvaluationHandoff{
				Ready:               false,
				State:               "retry_scheduled",
				FinalOutcomeDecided: false,
			}
			intermediateResult.Metadata.RetryCount = currentRetryCount
			intermediateResult.Metadata.FailurePatternHint = firstNonEmpty(currentFailurePatternHint, intermediateResult.Metadata.FailurePatternHint)
			intermediateResult.Retry.Eligible = true
			intermediateResult.Retry.Remaining = max(0, contractDecision.Plan.EffectiveMaxAttempts-currentAttempt)
			intermediateResult.Retry.MaxAttempts = contractDecision.Plan.EffectiveMaxAttempts
			confidenceScore := intermediateResult.Confidence.Score

			if err := s.store.FinalizeRun(ctx, store.FinalizeRunInput{
				PlanID:          claimed.Task.PlanID,
				TaskID:          claimed.Task.ID,
				SessionID:       claimed.SessionID,
				RunID:           currentRunID,
				RunStatus:       string(outcome.Status),
				FailureType:     string(intermediateResult.FailureType),
				RetryCount:      intermediateResult.Metadata.RetryCount,
				ConfidenceScore: &confidenceScore,
				OutputPayload:   buildIntermediateRunPayload(intermediateResult, spec.JiraIssueKey),
				ErrorMessage:    outcome.FailureReason,
				EventType:       "execution_run_retryable_failure",
				EventPayload: map[string]any{
					"attempt_no":       currentAttempt,
					"execution_result": intermediateResult,
				},
			}); err != nil {
				return fmt.Errorf("record failed attempt %d: %w", currentAttempt, err)
			}

			nextRetryCount := currentRetryCount + 1
			retryRun, err := s.store.StartRetryRun(
				ctx,
				claimed.Task.PlanID,
				claimed.Task.ID,
				claimed.SessionID,
				claimed.WorkerName,
				nextRetryCount,
				buildRetryInputPayload(claimed.Task.InputPayload, nextRetryCount, spec.ExecutionIndex, currentFailurePatternHint),
			)
			if err != nil {
				findings = append(findings, "Retry allocation failed: "+err.Error())
				terminalFailureReason = strings.TrimSpace(terminalFailureReason + "; retry allocation failed: " + err.Error())
				terminalStatus = execresult.StatusFailed
				break
			}

			currentRunID = retryRun.RunID
			currentAttempt = retryRun.AttemptNo
			currentRetryCount = retryRun.RetryCount
			spec.RunID = currentRunID
			results = append(results, fmt.Sprintf("Retry attempt %d started.", currentAttempt))
		}
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

	fileChecks, fileFailureClassification, fileFailureReason := validateChangedFiles(contractDecision.Plan, spec, changedFiles)
	safetyChecks = append(safetyChecks, fileChecks...)
	if fileFailureClassification != execresult.FailureClassificationNone {
		terminalStatus = execresult.StatusFailed
		terminalFailureClassification = fileFailureClassification
		terminalFailureReason = fileFailureReason
		findings = append(findings, fileFailureReason)
		s.emitTelemetry(ctx, claimed, spec, &telemetry, "workspace", "changed_files_rejected", map[string]any{
			"classification": fileFailureClassification,
			"reason":         fileFailureReason,
		})
	}

	cleanupResult, cleanupErr := s.workspace.Cleanup(ctx, ws)
	if cleanupResult.CommandLine != "" || cleanupResult.Label != "" {
		commands = append(commands, cleanupResult)
	}
	if cleanupErr != nil {
		message := "Workspace cleanup failed: " + cleanupErr.Error()
		findings = append(findings, message)
		terminalAnomalies = append(terminalAnomalies, "workspace_cleanup_failed")
		if terminalFailureReason == "" {
			terminalFailureReason = message
		}
		if terminalFailureClassification == execresult.FailureClassificationNone {
			terminalFailureClassification = execresult.FailureClassificationWorkspaceFailure
		}
	} else {
		workspaceCleaned = true
		results = append(results, "Workspace cleaned after execution.")
	}

	terminalAnomalies = dedupe(terminalAnomalies)
	if terminalFailureReason == "" {
		results = append(results, "Codex completed successfully and all validation commands passed.")
	} else {
		results = append(results, "Execution completed and is ready for result evaluation.")
	}

	spec.RunID = currentRunID
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
		ws.BranchStrategy,
		workspaceCleaned,
		safetyChecks,
		telemetry,
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
	branchStrategy string,
	workspaceCleaned bool,
	safetyChecks []execresult.SafetyCheck,
	telemetry []execresult.TelemetryEntry,
) error {
	spec.RunID = runID
	promptPath := ""
	if promptFile != nil {
		promptPath = strings.TrimSpace(*promptFile)
	}
	effectiveMaxAttempts := buildExecutionPlan(spec.Contract.ExecutionMode, spec.Contract.Retry, s.cfg.MaxAttempts, spec.Contract.Write.DryRun, spec.Contract.Write.ReadOnly).EffectiveMaxAttempts

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
		effectiveMaxAttempts,
		branchStrategy,
		workspaceCleaned,
		safetyChecks,
		telemetry,
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
		effectiveMaxAttempts,
		branchStrategy,
		workspaceCleaned,
		safetyChecks,
		telemetry,
	)
	results = append(results, finalResult.Summary)

	artifactPath := ""
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
			effectiveMaxAttempts,
			branchStrategy,
			workspaceCleaned,
			safetyChecks,
			telemetry,
		)
	} else {
		artifactPath = artifactRecord.RelativePath
		finalResult.ArtifactPath = artifactPath
	}

	finalTelemetry := append([]execresult.TelemetryEntry(nil), telemetry...)
	s.emitTelemetry(ctx, claimed, spec, &finalTelemetry, "stop", telemetryStatus(!failureStatus(finalResult.Status)), map[string]any{
		"final_status":           finalResult.Status,
		"failure_classification": finalResult.FailureClassification,
		"failure_reason":         finalResult.FailureReason,
		"workspace_cleaned":      workspaceCleaned,
	})
	finalResult = buildTerminalExecutionResult(
		spec,
		finalResult.Status,
		finalResult.FailureClassification,
		finalResult.FailureReason,
		finalResult.Validation,
		attempts,
		anomalies,
		changedFiles,
		promptPath,
		effectiveMaxAttempts,
		branchStrategy,
		workspaceCleaned,
		safetyChecks,
		finalTelemetry,
	)
	if artifactPath != "" {
		finalResult.ArtifactPath = artifactPath
	}

	errorMessage := ""
	if finalResult.HasFailure() {
		errorMessage = finalResult.FailureReason
	}

	confidenceScore := finalResult.Confidence.Score
	if err := s.store.FinalizeRun(ctx, store.FinalizeRunInput{
		PlanID:          claimed.Task.PlanID,
		TaskID:          claimed.Task.ID,
		SessionID:       claimed.SessionID,
		RunID:           runID,
		RunStatus:       string(finalResult.Status),
		FailureType:     string(finalResult.FailureType),
		RetryCount:      finalResult.Metadata.RetryCount,
		ConfidenceScore: &confidenceScore,
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
		fmt.Sprintf("Execution mode: %s", result.Metadata.ExecutionMode),
		fmt.Sprintf("Contract ID: %s", result.Metadata.ContractID),
		fmt.Sprintf("Execution index: %d", result.Metadata.ExecutionIndex),
		fmt.Sprintf("Retry count: %d", result.Metadata.RetryCount),
		fmt.Sprintf("Confidence: %s (%.2f)", result.Confidence.Level, result.Confidence.Score),
		fmt.Sprintf("Validation: %d/%d commands passed, %d/%d tests passed", result.Validation.Passed, result.Validation.Total, result.Validation.TestPassed, result.Validation.TestTotal),
	}
	if result.Contract.Approval.Required {
		lines = append(lines, fmt.Sprintf("Approval granted: %t", result.Contract.Approval.Approved))
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
	if strings.TrimSpace(string(result.FailureType)) != "" {
		lines = append(lines, "Failure type: "+string(result.FailureType))
	}
	if len(result.RootCauseHints) > 0 {
		lines = append(lines, "Root cause hints:")
		for _, hint := range result.RootCauseHints {
			lines = append(lines, "- "+hint)
		}
	}
	if len(result.RetrySuggestions) > 0 {
		lines = append(lines, "Retry suggestions:")
		for _, hint := range result.RetrySuggestions {
			lines = append(lines, "- "+hint)
		}
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

func buildRetryInputPayload(payload map[string]any, retryCount int, executionIndex int, failurePatternHint string) map[string]any {
	cloned := make(map[string]any, len(payload)+3)
	for key, value := range payload {
		cloned[key] = value
	}
	cloned["retry_count"] = max(0, retryCount)
	cloned["execution_index"] = max(1, executionIndex)
	if strings.TrimSpace(failurePatternHint) != "" {
		cloned["failure_pattern_hint"] = failurePatternHint
	}
	return cloned
}
