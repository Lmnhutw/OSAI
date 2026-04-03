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
	"execution-go/internal/runner"
	"execution-go/internal/store"
	"execution-go/internal/workspace"
)

type JiraClient interface {
	SearchReadyIssues(ctx context.Context, maxResults int) ([]jira.Issue, error)
	TransitionIssue(ctx context.Context, issueKey, targetStatus string) error
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

	s.tryTransition(ctx, issue.Key, s.cfg.JiraInProgressStatus, &findings)

	if len(spec.LintCommands) == 0 && len(spec.TestCommands) == 0 {
		findings = append(findings, "No lint/test commands were configured for this task.")
		return s.finalizeFailure(ctx, issue, claimed, spec, claimed.RunID, commands, results, findings, decisions, nil, nil, "No lint/test commands were configured for this task.")
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
		findings = append(findings, "Workspace preparation failed: "+err.Error())
		return s.finalizeFailure(ctx, issue, claimed, spec, claimed.RunID, commands, results, findings, decisions, nil, nil, err.Error())
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
	var finalError string

	for {
		finalError = ""

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
		if runErr == nil {
			commands = append(commands, codexResult)
		}

		attemptFailures := make([]string, 0, 4)
		if runErr != nil {
			attemptFailures = append(attemptFailures, fmt.Sprintf("Attempt %d failed before Codex execution: %v", currentAttempt, runErr))
		} else if !codexResult.Success() {
			attemptFailures = append(attemptFailures, summarizeCommandFailure(codexResult))
		}

		qualityResults := s.quality.RunAll(ctx, execDir, spec.LintCommands, spec.TestCommands)
		commands = append(commands, qualityResults...)
		for _, result := range qualityResults {
			if !result.Success() {
				attemptFailures = append(attemptFailures, summarizeCommandFailure(result))
			}
		}

		if len(attemptFailures) == 0 {
			results = append(results, fmt.Sprintf("Attempt %d succeeded.", currentAttempt))
			break
		}

		finalError = strings.Join(attemptFailures, "; ")
		findings = append(findings, attemptFailures...)
		results = append(results, fmt.Sprintf("Attempt %d failed.", currentAttempt))

		if currentAttempt >= s.cfg.MaxAttempts {
			break
		}

		if err := s.store.FinalizeRun(ctx, store.FinalizeRunInput{
			PlanID:    claimed.Task.PlanID,
			TaskID:    claimed.Task.ID,
			SessionID: claimed.SessionID,
			RunID:     currentRunID,
			RunStatus: "failed",
			OutputPayload: map[string]any{
				"attempt_no":  currentAttempt,
				"status":      "retrying",
				"prompt_file": lastPromptFile,
			},
			ErrorMessage: finalError,
			EventType:    "execution_run_failed",
			EventPayload: map[string]any{
				"attempt_no": currentAttempt,
				"errors":     attemptFailures,
			},
		}); err != nil {
			return fmt.Errorf("record failed attempt %d: %w", currentAttempt, err)
		}

		retryRun, err := s.store.StartRetryRun(ctx, claimed.Task.PlanID, claimed.Task.ID, claimed.SessionID, claimed.WorkerName, claimed.Task.InputPayload)
		if err != nil {
			findings = append(findings, "Retry allocation failed: "+err.Error())
			finalError = finalError + "; retry allocation failed: " + err.Error()
			break
		}

		retryContext = append(retryContext, attemptFailures...)
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
		findings = append(findings, "Failed to collect changed files: "+summarizeCommandFailure(changedFilesResult))
	}

	if finalError != "" {
		return s.finalizeFailure(ctx, issue, claimed, spec, currentRunID, commands, results, findings, decisions, changedFiles, &lastPromptFile, finalError)
	}

	results = append(results, "Codex completed successfully and all validation commands passed.")
	return s.finalizeSuccess(ctx, issue, claimed, spec, currentRunID, commands, results, findings, decisions, changedFiles, &lastPromptFile)
}

func (s *Service) finalizeSuccess(
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
) error {
	artifactRecord, err := s.writeArtifact(ctx, issue, spec, commands, results, findings, decisions, changedFiles)
	if err != nil {
		findings = append(findings, "Artifact write failed: "+err.Error())
		results = append(results, "Artifact write failed.")
		return s.finalizeFailure(ctx, issue, claimed, spec, runID, commands, results, findings, decisions, changedFiles, promptFile, err.Error())
	}

	outputPayload := map[string]any{
		"status":         "completed",
		"jira_issue_key": spec.JiraIssueKey,
		"artifact_path":  artifactRecord.RelativePath,
		"files_changed":  changedFiles,
	}
	if promptFile != nil && strings.TrimSpace(*promptFile) != "" {
		outputPayload["prompt_file"] = *promptFile
	}

	if err := s.store.FinalizeRun(ctx, store.FinalizeRunInput{
		PlanID:        claimed.Task.PlanID,
		TaskID:        claimed.Task.ID,
		SessionID:     claimed.SessionID,
		RunID:         runID,
		RunStatus:     "succeeded",
		SessionStatus: "completed",
		TaskStatus:    "completed",
		ArtifactPath:  artifactRecord.RelativePath,
		OutputPayload: outputPayload,
		EventType:     "task_completed",
		EventPayload: map[string]any{
			"files_changed": changedFiles,
		},
	}); err != nil {
		return fmt.Errorf("finalize successful task: %w", err)
	}

	s.tryTransition(ctx, issue.Key, s.cfg.JiraDoneStatus, nil)
	return nil
}

func (s *Service) finalizeFailure(
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
	errMessage string,
) error {
	results = append(results, "Execution finished in a failed state.")

	artifactPath := ""
	artifactRecord, err := s.writeArtifact(ctx, issue, spec, commands, results, findings, decisions, changedFiles)
	if err == nil {
		artifactPath = artifactRecord.RelativePath
	} else {
		s.logger.Error("failed to write failure artifact", "task_id", claimed.Task.ID, "error", err)
	}

	outputPayload := map[string]any{
		"status":         "failed",
		"jira_issue_key": spec.JiraIssueKey,
		"artifact_path":  artifactPath,
		"files_changed":  changedFiles,
	}
	if promptFile != nil && strings.TrimSpace(*promptFile) != "" {
		outputPayload["prompt_file"] = *promptFile
	}

	if err := s.store.FinalizeRun(ctx, store.FinalizeRunInput{
		PlanID:        claimed.Task.PlanID,
		TaskID:        claimed.Task.ID,
		SessionID:     claimed.SessionID,
		RunID:         runID,
		RunStatus:     "failed",
		SessionStatus: "failed",
		TaskStatus:    "failed",
		ArtifactPath:  artifactPath,
		OutputPayload: outputPayload,
		ErrorMessage:  errMessage,
		EventType:     "task_failed",
		EventPayload: map[string]any{
			"error":         errMessage,
			"files_changed": changedFiles,
		},
	}); err != nil {
		return fmt.Errorf("finalize failed task: %w", err)
	}

	s.tryTransition(ctx, issue.Key, s.cfg.JiraFailedStatus, nil)
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
) (artifact.Artifact, error) {
	return s.artifact.Write(ctx, artifact.Report{
		TaskID:             spec.TaskID,
		JiraIssueKey:       issue.Key,
		Goal:               spec.Goal,
		AcceptanceCriteria: spec.AcceptanceCriteria,
		FilesChanged:       changedFiles,
		Commands:           commands,
		Results:            dedupe(results),
		Findings:           dedupe(findings),
		Decisions:          dedupe(decisions),
	})
}

func (s *Service) tryTransition(ctx context.Context, issueKey, targetStatus string, findings *[]string) {
	if strings.TrimSpace(targetStatus) == "" {
		return
	}

	transitionCtx, cancel := context.WithTimeout(ctx, s.cfg.JiraRequestTimeout)
	defer cancel()

	if err := s.jira.TransitionIssue(transitionCtx, issueKey, targetStatus); err != nil {
		s.logger.Warn("failed to transition jira issue", "issue", issueKey, "target_status", targetStatus, "error", err)
		if findings != nil {
			*findings = append(*findings, fmt.Sprintf("Failed to transition Jira issue %s to %s: %v", issueKey, targetStatus, err))
		}
	}
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
