package worker

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"execution-go/internal/artifact"
	"execution-go/internal/cli"
	"execution-go/internal/config"
	"execution-go/internal/jira"
	execresult "execution-go/internal/result"
	"execution-go/internal/runner"
	"execution-go/internal/store"
	"execution-go/internal/workspace"
)

func TestExecuteClaimedTaskRetriesAndCompletes(t *testing.T) {
	t.Parallel()

	cfg := config.Config{
		WorkerName:           "worker-1",
		MaxAttempts:          2,
		JiraRequestTimeout:   time.Second,
		JiraInProgressStatus: "In Progress",
		JiraEvaluationStatus: "Ready for Evaluation",
	}

	fakeStore := &stubStore{
		retryRun: &store.RunAttempt{RunID: "run-2", AttemptNo: 2, RetryCount: 1},
	}
	fakeJira := &stubJira{}
	fakeWorkspace := &stubWorkspace{
		ws: workspace.Workspace{
			RootPath:       "C:/tmp/ws-run",
			Path:           "C:/tmp/ws",
			MetadataPath:   "C:/tmp/ws-run/.execution",
			BranchName:     "codex/ops-1",
			BranchStrategy: "created_from_base",
		},
		changedFiles: []string{"internal/worker/service.go"},
	}
	fakeCodex := &stubCodex{
		results: []cli.Result{
			{Label: "codex", CommandLine: "codex exec", ExitCode: 0},
			{Label: "codex", CommandLine: "codex exec", ExitCode: 0},
		},
	}
	fakeQuality := &stubQuality{
		results: [][]cli.Result{
			{{Label: "test-1", CommandLine: "go test ./...", ExitCode: 1, Stderr: "failing test"}},
			{{Label: "test-1", CommandLine: "go test ./...", ExitCode: 0}},
		},
	}
	fakeArtifacts := &stubArtifactWriter{
		artifact: artifact.Artifact{RelativePath: "artifacts/execution-go/run.md"},
	}

	service := NewService(
		cfg,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		fakeJira,
		fakeStore,
		fakeWorkspace,
		fakeCodex,
		fakeQuality,
		fakeArtifacts,
	)

	claimed := &store.ClaimedTask{
		Task: store.Task{
			ID:           "task-1",
			PlanID:       "plan-1",
			Title:        "Build worker",
			Instructions: "Implement the execution worker.",
			InputPayload: map[string]any{
				"goal":               "Implement worker",
				"test_commands":      []any{"go test ./..."},
				"repo_url":           "C:/repo",
				"base_branch":        "main",
				"working_dir":        ".",
				"acceptanceCriteria": []any{"All tests pass"},
				"execution_contract": validExecutionContract("task-1", execresult.ExecutionModeExecuteWithValidation, 1),
			},
		},
		SessionID:      "session-1",
		RunID:          "run-1",
		AttemptNo:      1,
		RetryCount:     0,
		ExecutionIndex: 1,
		JiraIssueKey:   "OPS-1",
		WorkerName:     "worker-1",
	}

	err := service.executeClaimedTask(context.Background(), jira.Issue{Key: "OPS-1", Summary: "Build worker"}, claimed)
	if err != nil {
		t.Fatalf("executeClaimedTask returned error: %v", err)
	}

	if len(fakeStore.finalizeCalls) != 2 {
		t.Fatalf("expected 2 finalize calls, got %d", len(fakeStore.finalizeCalls))
	}
	if fakeStore.finalizeCalls[0].RunStatus != "retryable_failure" {
		t.Fatalf("expected first finalize to mark retryable failure, got %+v", fakeStore.finalizeCalls[0])
	}
	if fakeStore.finalizeCalls[0].RetryCount != 0 {
		t.Fatalf("expected first finalize retry count to stay at 0, got %+v", fakeStore.finalizeCalls[0])
	}
	if fakeStore.finalizeCalls[1].TaskStatus != evaluationReadyState {
		t.Fatalf("expected final finalize to mark task evaluation ready, got %+v", fakeStore.finalizeCalls[1])
	}
	if fakeStore.finalizeCalls[1].SessionStatus != evaluationReadyState {
		t.Fatalf("expected final finalize to mark session evaluation ready, got %+v", fakeStore.finalizeCalls[1])
	}
	if fakeStore.finalizeCalls[1].EventType != evaluationReadyEventType {
		t.Fatalf("expected final event type %q, got %+v", evaluationReadyEventType, fakeStore.finalizeCalls[1])
	}
	if fakeStore.retryCount != 1 {
		t.Fatalf("expected 1 retry, got %d", fakeStore.retryCount)
	}
	if len(fakeJira.transitions) != 2 {
		t.Fatalf("expected 2 jira transitions, got %d", len(fakeJira.transitions))
	}
	if fakeJira.transitions[0] != "OPS-1->In Progress" || fakeJira.transitions[1] != "OPS-1->Ready for Evaluation" {
		t.Fatalf("unexpected jira transitions: %#v", fakeJira.transitions)
	}
	if len(fakeJira.comments) != 1 || !strings.Contains(fakeJira.comments[0], "Execution is ready for result evaluation.") {
		t.Fatalf("expected one jira comment with evaluation handoff, got %#v", fakeJira.comments)
	}
	if fakeArtifacts.report.TaskID != "task-1" {
		t.Fatalf("expected artifact task id to be task-1, got %q", fakeArtifacts.report.TaskID)
	}
	if fakeArtifacts.report.Execution == nil || fakeArtifacts.report.Execution.Status != execresult.StatusSucceeded {
		t.Fatalf("expected artifact to capture succeeded execution result, got %+v", fakeArtifacts.report.Execution)
	}

	executionResult, ok := fakeStore.finalizeCalls[1].OutputPayload["execution_result"].(execresult.ExecutionResult)
	if !ok {
		t.Fatalf("expected structured execution result in output payload, got %#v", fakeStore.finalizeCalls[1].OutputPayload["execution_result"])
	}
	if executionResult.Evaluation.State != evaluationReadyState {
		t.Fatalf("expected execution result to be evaluation ready, got %+v", executionResult)
	}
	if executionResult.Metadata.ExecutionIndex != 1 || executionResult.Metadata.RetryCount != 1 {
		t.Fatalf("expected execution metadata to persist loop counters, got %+v", executionResult.Metadata)
	}
	if !executionResult.Metadata.WorkspaceCleaned {
		t.Fatalf("expected workspace cleanup to be recorded, got %+v", executionResult.Metadata)
	}
	if len(executionResult.History) != 2 {
		t.Fatalf("expected execution history to contain both attempts, got %+v", executionResult.History)
	}
}

func TestExecuteClaimedTaskStopsOnRepeatedFailurePattern(t *testing.T) {
	t.Parallel()

	cfg := config.Config{
		WorkerName:         "worker-1",
		MaxAttempts:        3,
		JiraRequestTimeout: time.Second,
	}

	fakeStore := &stubStore{
		retryRun: &store.RunAttempt{RunID: "run-2", AttemptNo: 2, RetryCount: 1},
	}
	service := NewService(
		cfg,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		&stubJira{},
		fakeStore,
		&stubWorkspace{ws: workspace.Workspace{
			RootPath:       "C:/tmp/ws-run",
			Path:           "C:/tmp/ws",
			MetadataPath:   "C:/tmp/ws-run/.execution",
			BranchName:     "codex/ops-1",
			BranchStrategy: "created_from_base",
		}, changedFiles: []string{"internal/worker/service.go"}},
		&stubCodex{results: []cli.Result{
			{Label: "codex", CommandLine: "codex exec", ExitCode: 0},
			{Label: "codex", CommandLine: "codex exec", ExitCode: 0},
		}},
		&stubQuality{results: [][]cli.Result{
			{{Label: "test-1", CommandLine: "go test ./...", ExitCode: 1, Stderr: "same failure"}},
			{{Label: "test-1", CommandLine: "go test ./...", ExitCode: 1, Stderr: "same failure"}},
		}},
		&stubArtifactWriter{artifact: artifact.Artifact{RelativePath: "artifacts/execution-go/run.md"}},
	)

	claimed := &store.ClaimedTask{
		Task: store.Task{
			ID:           "task-1",
			PlanID:       "plan-1",
			Title:        "Build worker",
			Instructions: "Implement the execution worker.",
			InputPayload: map[string]any{
				"goal":               "Implement worker",
				"test_commands":      []any{"go test ./..."},
				"execution_contract": validExecutionContract("task-1", execresult.ExecutionModeExecuteWithValidation, 2),
			},
		},
		SessionID:      "session-1",
		RunID:          "run-1",
		AttemptNo:      1,
		RetryCount:     0,
		ExecutionIndex: 1,
		JiraIssueKey:   "OPS-1",
		WorkerName:     "worker-1",
	}

	if err := service.executeClaimedTask(context.Background(), jira.Issue{Key: "OPS-1", Summary: "Build worker"}, claimed); err != nil {
		t.Fatalf("executeClaimedTask returned error: %v", err)
	}

	if fakeStore.retryCount != 1 {
		t.Fatalf("expected repeated failure pattern to stop after one retry, got %d", fakeStore.retryCount)
	}
	if len(fakeStore.finalizeCalls) != 2 {
		t.Fatalf("expected one retryable finalize and one terminal finalize, got %d", len(fakeStore.finalizeCalls))
	}

	executionResult, ok := fakeStore.finalizeCalls[1].OutputPayload["execution_result"].(execresult.ExecutionResult)
	if !ok {
		t.Fatalf("expected structured execution result in terminal payload, got %#v", fakeStore.finalizeCalls[1].OutputPayload["execution_result"])
	}
	if !executionResult.Retry.RepeatedFailurePattern {
		t.Fatalf("expected repeated failure pattern to be recorded, got %+v", executionResult.Retry)
	}
}

func TestExecuteClaimedTaskRejectsMissingApproval(t *testing.T) {
	t.Parallel()

	cfg := config.Config{
		WorkerName:         "worker-1",
		MaxAttempts:        2,
		JiraRequestTimeout: time.Second,
	}

	fakeStore := &stubStore{}
	fakeCodex := &stubCodex{}
	fakeQuality := &stubQuality{}
	service := NewService(
		cfg,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		&stubJira{},
		fakeStore,
		&stubWorkspace{ws: workspace.Workspace{
			RootPath:       "C:/tmp/ws-run",
			Path:           "C:/tmp/ws",
			MetadataPath:   "C:/tmp/ws-run/.execution",
			BranchName:     "codex/ops-1",
			BranchStrategy: "created_from_base",
		}},
		fakeCodex,
		fakeQuality,
		&stubArtifactWriter{artifact: artifact.Artifact{RelativePath: "artifacts/execution-go/run.md"}},
	)

	contract := validExecutionContract("task-1", execresult.ExecutionModeExecuteWithValidation, 0)
	approval := contract["approval"].(map[string]any)
	approval["required"] = true
	approval["approved"] = false

	claimed := &store.ClaimedTask{
		Task: store.Task{
			ID:           "task-1",
			PlanID:       "plan-1",
			Title:        "Blocked worker",
			Instructions: "Implement the execution worker.",
			InputPayload: map[string]any{
				"goal":               "Implement worker",
				"test_commands":      []any{"go test ./..."},
				"execution_contract": contract,
			},
		},
		SessionID:      "session-1",
		RunID:          "run-1",
		AttemptNo:      1,
		RetryCount:     0,
		ExecutionIndex: 1,
		JiraIssueKey:   "OPS-2",
		WorkerName:     "worker-1",
	}

	if err := service.executeClaimedTask(context.Background(), jira.Issue{Key: "OPS-2", Summary: "Blocked worker"}, claimed); err != nil {
		t.Fatalf("executeClaimedTask returned error: %v", err)
	}
	if fakeCodex.index != 0 {
		t.Fatalf("expected approval rejection to skip Codex, got %d runs", fakeCodex.index)
	}
	if fakeQuality.index != 0 {
		t.Fatalf("expected approval rejection to skip validation, got %d runs", fakeQuality.index)
	}

	executionResult, ok := fakeStore.finalizeCalls[0].OutputPayload["execution_result"].(execresult.ExecutionResult)
	if !ok {
		t.Fatalf("expected structured execution result, got %#v", fakeStore.finalizeCalls[0].OutputPayload["execution_result"])
	}
	if executionResult.FailureClassification != execresult.FailureClassificationApprovalMissing {
		t.Fatalf("expected approval_missing classification, got %+v", executionResult)
	}
}

func TestExecuteClaimedTaskInspectOnlySkipsCodexAndValidation(t *testing.T) {
	t.Parallel()

	cfg := config.Config{
		WorkerName:         "worker-1",
		MaxAttempts:        1,
		JiraRequestTimeout: time.Second,
	}

	fakeStore := &stubStore{}
	fakeCodex := &stubCodex{}
	fakeQuality := &stubQuality{}
	service := NewService(
		cfg,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		&stubJira{},
		fakeStore,
		&stubWorkspace{ws: workspace.Workspace{
			RootPath:       "C:/tmp/ws-run",
			Path:           "C:/tmp/ws",
			MetadataPath:   "C:/tmp/ws-run/.execution",
			BranchName:     "codex/ops-3",
			BranchStrategy: "created_from_base",
		}, changedFiles: nil},
		fakeCodex,
		fakeQuality,
		&stubArtifactWriter{artifact: artifact.Artifact{RelativePath: "artifacts/execution-go/run.md"}},
	)

	claimed := &store.ClaimedTask{
		Task: store.Task{
			ID:           "task-3",
			PlanID:       "plan-1",
			Title:        "Inspect worker",
			Instructions: "Inspect the worker only.",
			InputPayload: map[string]any{
				"goal":               "Inspect worker",
				"execution_contract": validExecutionContract("task-3", execresult.ExecutionModeInspectOnly, 0),
			},
		},
		SessionID:      "session-3",
		RunID:          "run-3",
		AttemptNo:      1,
		RetryCount:     0,
		ExecutionIndex: 1,
		JiraIssueKey:   "OPS-3",
		WorkerName:     "worker-1",
	}

	if err := service.executeClaimedTask(context.Background(), jira.Issue{Key: "OPS-3", Summary: "Inspect worker"}, claimed); err != nil {
		t.Fatalf("executeClaimedTask returned error: %v", err)
	}
	if fakeCodex.index != 0 {
		t.Fatalf("expected inspect_only to skip Codex, got %d runs", fakeCodex.index)
	}
	if fakeQuality.index != 0 {
		t.Fatalf("expected inspect_only to skip validation, got %d runs", fakeQuality.index)
	}

	executionResult, ok := fakeStore.finalizeCalls[0].OutputPayload["execution_result"].(execresult.ExecutionResult)
	if !ok {
		t.Fatalf("expected structured execution result, got %#v", fakeStore.finalizeCalls[0].OutputPayload["execution_result"])
	}
	if executionResult.Metadata.ExecutionMode != string(execresult.ExecutionModeInspectOnly) {
		t.Fatalf("expected inspect_only execution mode, got %+v", executionResult.Metadata)
	}
	if executionResult.Status != execresult.StatusSucceeded && executionResult.Status != execresult.StatusPartialSuccess {
		t.Fatalf("expected inspect-only run to complete without failure, got %+v", executionResult)
	}
}

func TestExecuteClaimedTaskRejectsRetryLimitExceeded(t *testing.T) {
	t.Parallel()

	cfg := config.Config{
		WorkerName:         "worker-1",
		MaxAttempts:        3,
		JiraRequestTimeout: time.Second,
	}

	fakeStore := &stubStore{}
	service := NewService(
		cfg,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		&stubJira{},
		fakeStore,
		&stubWorkspace{ws: workspace.Workspace{
			RootPath:       "C:/tmp/ws-run",
			Path:           "C:/tmp/ws",
			MetadataPath:   "C:/tmp/ws-run/.execution",
			BranchName:     "codex/ops-4",
			BranchStrategy: "created_from_base",
		}},
		&stubCodex{},
		&stubQuality{},
		&stubArtifactWriter{artifact: artifact.Artifact{RelativePath: "artifacts/execution-go/run.md"}},
	)

	claimed := &store.ClaimedTask{
		Task: store.Task{
			ID:           "task-4",
			PlanID:       "plan-1",
			Title:        "Retry capped worker",
			Instructions: "Implement the worker.",
			InputPayload: map[string]any{
				"goal":               "Implement worker",
				"execution_contract": validExecutionContract("task-4", execresult.ExecutionModeExecuteWithWrite, 1),
			},
		},
		SessionID:      "session-4",
		RunID:          "run-4",
		AttemptNo:      1,
		RetryCount:     2,
		ExecutionIndex: 1,
		JiraIssueKey:   "OPS-4",
		WorkerName:     "worker-1",
	}

	if err := service.executeClaimedTask(context.Background(), jira.Issue{Key: "OPS-4", Summary: "Retry capped worker"}, claimed); err != nil {
		t.Fatalf("executeClaimedTask returned error: %v", err)
	}

	executionResult, ok := fakeStore.finalizeCalls[0].OutputPayload["execution_result"].(execresult.ExecutionResult)
	if !ok {
		t.Fatalf("expected structured execution result, got %#v", fakeStore.finalizeCalls[0].OutputPayload["execution_result"])
	}
	if executionResult.FailureClassification != execresult.FailureClassificationRetryLimitExceeded {
		t.Fatalf("expected retry_limit_exceeded classification, got %+v", executionResult)
	}
}

type stubJira struct {
	transitions []string
	comments    []string
}

func (s *stubJira) SearchReadyIssues(ctx context.Context, maxResults int) ([]jira.Issue, error) {
	return nil, nil
}

func (s *stubJira) TransitionIssue(ctx context.Context, issueKey, targetStatus string) error {
	s.transitions = append(s.transitions, issueKey+"->"+targetStatus)
	return nil
}

func (s *stubJira) AddComment(ctx context.Context, issueKey, body string) error {
	s.comments = append(s.comments, body)
	return nil
}

type stubStore struct {
	retryRun       *store.RunAttempt
	finalizeCalls  []store.FinalizeRunInput
	retryCount     int
	recordedEvents []store.RecordEventInput
}

func (s *stubStore) ClaimReadyTask(ctx context.Context, jiraIssueKey, workerName string) (*store.ClaimedTask, error) {
	return nil, nil
}

func (s *stubStore) StartRetryRun(ctx context.Context, planID, taskID, sessionID, workerName string, retryCount int, inputPayload map[string]any) (*store.RunAttempt, error) {
	s.retryCount++
	return s.retryRun, nil
}

func (s *stubStore) FinalizeRun(ctx context.Context, input store.FinalizeRunInput) error {
	s.finalizeCalls = append(s.finalizeCalls, input)
	return nil
}

func (s *stubStore) RecordEvent(ctx context.Context, input store.RecordEventInput) error {
	s.recordedEvents = append(s.recordedEvents, input)
	return nil
}

type stubWorkspace struct {
	ws           workspace.Workspace
	changedFiles []string
	cleanupRuns  int
}

func (s *stubWorkspace) Prepare(ctx context.Context, req workspace.PrepareRequest) (workspace.Workspace, []cli.Result, error) {
	return s.ws, []cli.Result{{Label: "git clone", CommandLine: "git clone", ExitCode: 0}}, nil
}

func (s *stubWorkspace) ChangedFiles(ctx context.Context, workspacePath string) ([]string, cli.Result) {
	return append([]string(nil), s.changedFiles...), cli.Result{Label: "git status", CommandLine: "git status --short", ExitCode: 0}
}

func (s *stubWorkspace) Cleanup(ctx context.Context, ws workspace.Workspace) (cli.Result, error) {
	s.cleanupRuns++
	return cli.Result{Label: "workspace cleanup", CommandLine: "cleanup workspace", ExitCode: 0}, nil
}

type stubCodex struct {
	results []cli.Result
	index   int
}

func (s *stubCodex) Run(ctx context.Context, req runner.CodexRequest) (cli.Result, string, error) {
	result := s.results[s.index]
	s.index++
	return result, "prompt.md", nil
}

type stubQuality struct {
	results [][]cli.Result
	index   int
}

func (s *stubQuality) RunAll(ctx context.Context, workspacePath string, lintCommands, testCommands []string) []cli.Result {
	result := s.results[s.index]
	s.index++
	return result
}

type stubArtifactWriter struct {
	artifact artifact.Artifact
	report   artifact.Report
}

func (s *stubArtifactWriter) Write(ctx context.Context, report artifact.Report) (artifact.Artifact, error) {
	s.report = report
	return s.artifact, nil
}

func validExecutionContract(taskID string, mode execresult.ExecutionMode, maxRetry int) map[string]any {
	allowWrite := mode == execresult.ExecutionModeDraftChanges || mode == execresult.ExecutionModeExecuteWithWrite || mode == execresult.ExecutionModeExecuteWithValidation
	allowedActions := []any{"prepare_workspace"}
	switch mode {
	case execresult.ExecutionModeInspectOnly:
		allowedActions = append(allowedActions, "inspect_workspace")
	case execresult.ExecutionModeDraftChanges, execresult.ExecutionModeExecuteWithWrite:
		allowedActions = append(allowedActions, "run_codex", "write_workspace")
	case execresult.ExecutionModeExecuteWithValidation:
		allowedActions = append(allowedActions, "run_codex", "write_workspace", "run_validation")
	}

	contract := map[string]any{
		"id":              "contract-" + taskID,
		"task_id":         taskID,
		"execution_mode":  string(mode),
		"allowed_actions": allowedActions,
		"retry": map[string]any{
			"allowed":   maxRetry > 0,
			"max_retry": maxRetry,
		},
		"branch_policy": map[string]any{
			"base_branch":             "main",
			"target_branch":           "codex/" + taskID,
			"approved_target_branch":  "codex/" + taskID,
			"allowed_target_branches": []any{"codex/" + taskID},
			"require_approved_target": allowWrite,
			"approved":                true,
		},
		"write_permissions": map[string]any{
			"allow_write":         allowWrite,
			"read_only":           mode == execresult.ExecutionModeInspectOnly,
			"dry_run":             false,
			"workspace_only":      true,
			"no_autonomous_write": false,
			"allowed_paths":       []any{"internal/worker"},
		},
		"approval": map[string]any{
			"required": false,
			"approved": true,
		},
		"policy_version":         "phase4",
		"autonomy_reasoning_ref": "autonomy://task/" + taskID,
	}
	if mode == execresult.ExecutionModeInspectOnly {
		contract["retry"] = map[string]any{"allowed": false, "max_retry": 0}
	}
	return contract
}
