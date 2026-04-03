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
		retryRun: &store.RunAttempt{RunID: "run-2", AttemptNo: 2},
	}
	fakeJira := &stubJira{}
	fakeWorkspace := &stubWorkspace{
		ws: workspace.Workspace{Path: "C:/tmp/ws", BranchName: "codex/ops-1"},
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
			},
		},
		SessionID:    "session-1",
		RunID:        "run-1",
		AttemptNo:    1,
		JiraIssueKey: "OPS-1",
		WorkerName:   "worker-1",
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
}

func TestExecuteClaimedTaskStopsOnRepeatedFailurePattern(t *testing.T) {
	t.Parallel()

	cfg := config.Config{
		WorkerName:         "worker-1",
		MaxAttempts:        3,
		JiraRequestTimeout: time.Second,
	}

	fakeStore := &stubStore{
		retryRun: &store.RunAttempt{RunID: "run-2", AttemptNo: 2},
	}
	service := NewService(
		cfg,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		&stubJira{},
		fakeStore,
		&stubWorkspace{ws: workspace.Workspace{Path: "C:/tmp/ws", BranchName: "codex/ops-1"}},
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
				"goal":          "Implement worker",
				"test_commands": []any{"go test ./..."},
			},
		},
		SessionID:    "session-1",
		RunID:        "run-1",
		AttemptNo:    1,
		JiraIssueKey: "OPS-1",
		WorkerName:   "worker-1",
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
	retryRun      *store.RunAttempt
	finalizeCalls []store.FinalizeRunInput
	retryCount    int
}

func (s *stubStore) ClaimReadyTask(ctx context.Context, jiraIssueKey, workerName string) (*store.ClaimedTask, error) {
	return nil, nil
}

func (s *stubStore) StartRetryRun(ctx context.Context, planID, taskID, sessionID, workerName string, inputPayload map[string]any) (*store.RunAttempt, error) {
	s.retryCount++
	return s.retryRun, nil
}

func (s *stubStore) FinalizeRun(ctx context.Context, input store.FinalizeRunInput) error {
	s.finalizeCalls = append(s.finalizeCalls, input)
	return nil
}

type stubWorkspace struct {
	ws workspace.Workspace
}

func (s *stubWorkspace) Prepare(ctx context.Context, req workspace.PrepareRequest) (workspace.Workspace, []cli.Result, error) {
	return s.ws, []cli.Result{{Label: "git clone", CommandLine: "git clone", ExitCode: 0}}, nil
}

func (s *stubWorkspace) ChangedFiles(ctx context.Context, workspacePath string) ([]string, cli.Result) {
	return []string{"internal/worker/service.go"}, cli.Result{Label: "git status", CommandLine: "git status --short", ExitCode: 0}
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
