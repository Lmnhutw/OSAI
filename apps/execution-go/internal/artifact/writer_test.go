package artifact

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"execution-go/internal/cli"
	execresult "execution-go/internal/result"
)

func TestWriterWritesRequiredSections(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	writer := NewWriter(root, root)

	report := Report{
		TaskID:             "TASK-123",
		JiraIssueKey:       "OPS-12",
		Goal:               "Implement the worker loop",
		AcceptanceCriteria: []string{"Poll Jira", "Persist execution runs"},
		Execution: &execresult.ExecutionResult{
			Status:                execresult.StatusPartialSuccess,
			Summary:               "Execution finished with status partial_success after 2 attempt(s).",
			ReasoningSummary:      "Prepared the workspace, retried once after a validation failure, and produced an evaluation-ready result.",
			FailureClassification: execresult.FailureClassificationValidationFailure,
			FailureType:           execresult.FailureClassificationValidationFailure,
			FailureReason:         "test-1 failed with exit code 1",
			RetrySuggestions:      []string{"Focus the next retry on the failing lint or test commands only."},
			RootCauseHints:        []string{"Test validation failed in test-1.", "Some validation passed, which suggests the implementation is partially complete."},
			Partial: execresult.PartialExecution{
				IncompleteImplementation: true,
				ReasonCode:               "validation_failed_after_changes",
				Reason:                   "test-1 failed with exit code 1",
			},
			Confidence: execresult.Confidence{
				Score:   0.63,
				Level:   execresult.ConfidenceMedium,
				Signals: []string{"Codex execution completed.", "1 of 2 validation commands passed."},
			},
			DetectedAnomalies: []string{"changed_files_collection_failed"},
			Retry: execresult.RetryGuidance{
				Eligible:    false,
				Remaining:   0,
				MaxAttempts: 2,
				Reason:      "Automatic retries are complete for this task.",
				Suggestions: []string{"Focus the next retry on the failing lint or test commands only."},
			},
			Validation: execresult.ValidationSummary{
				Total:      2,
				Passed:     1,
				Failed:     1,
				TestTotal:  1,
				TestFailed: 1,
			},
			Evaluation: execresult.EvaluationHandoff{
				Ready:               true,
				State:               "evaluation_ready",
				EventType:           "execution_result.ready_for_evaluation",
				FinalOutcomeDecided: false,
			},
			AttemptCount: 2,
			Contract: execresult.ExecutionContract{
				ID:            "contract-1",
				TaskID:        "TASK-123",
				ExecutionMode: execresult.ExecutionModeExecuteWithValidation,
				AllowedActions: []string{
					"prepare_workspace",
					"run_codex",
					"write_workspace",
					"run_validation",
				},
				Retry: execresult.RetryAllowance{Allowed: true, MaxRetry: 1},
				Branch: execresult.BranchPolicy{
					TargetBranch:          "codex/ops-12-worker",
					ApprovedTargetBranch:  "codex/ops-12-worker",
					AllowedTargetBranches: []string{"codex/ops-12-worker"},
					RequireApprovedTarget: true,
					Approved:              true,
				},
				Write: execresult.WritePermissions{
					AllowWrite:    true,
					WorkspaceOnly: true,
					AllowedPaths:  []string{"internal/worker"},
				},
				Approval:             execresult.ApprovalState{Required: true, Approved: true, Reference: "approval-1"},
				PolicyVersion:        "phase4",
				AutonomyReasoningRef: "autonomy://task/TASK-123",
			},
			PolicySnapshot: execresult.PolicySnapshot{
				Version:            "phase4",
				AutonomyMode:       "auto_execute",
				RetryAllowed:       true,
				MaxRetry:           1,
				AllowedActions:     []string{"dispatch_execution"},
				ReasonCodes:        []string{"safe_write_scope"},
				TaskClassification: "medium_risk_implementation",
			},
			SafetyChecks: []execresult.SafetyCheck{
				{Name: "execution_contract_present", Status: "passed", Detail: "Contract supplied."},
			},
			Telemetry: []execresult.TelemetryEntry{
				{Stage: "start", Status: "started", Timestamp: time.Now().UTC()},
			},
			Metadata: execresult.ExecutionMetadata{
				RunID:              "run-1",
				TaskID:             "TASK-123",
				WorkerID:           "worker-1",
				ContractID:         "contract-1",
				PolicyVersion:      "phase4",
				ExecutionMode:      string(execresult.ExecutionModeExecuteWithValidation),
				ExecutionIndex:     3,
				RetryCount:         1,
				FailurePatternHint: "validation_failure|test-1|failed",
				BranchName:         "codex/ops-12-worker",
				BranchStrategy:     "reused_remote_branch",
				WorkspaceCleaned:   true,
			},
			History: []execresult.AttemptSummary{
				{
					AttemptNo:      1,
					RetryCount:     0,
					Status:         execresult.StatusRetryableFailure,
					Summary:        "Attempt 1 failed but can be retried safely.",
					FailureType:    execresult.FailureClassificationValidationFailure,
					FailureReason:  "test-1 failed with exit code 1",
					RootCauseHints: []string{"Test validation failed in test-1."},
				},
				{
					AttemptNo:      2,
					RetryCount:     1,
					Status:         execresult.StatusPartialSuccess,
					Summary:        "Attempt 2 produced partial success.",
					FailureType:    execresult.FailureClassificationValidationFailure,
					FailureReason:  "test-1 failed with exit code 1",
					RootCauseHints: []string{"Some validation passed, which suggests the implementation is partially complete."},
				},
			},
			CompletedAt: time.Now().UTC(),
		},
		FilesChanged: []string{"internal/worker/service.go"},
		Commands: []cli.Result{
			{
				Label:       "codex",
				CommandLine: "codex exec",
				Dir:         ".",
				ExitCode:    0,
				Duration:    time.Second,
				Stdout:      "ok",
			},
		},
		Results:   []string{"Execution completed successfully."},
		Findings:  []string{"No findings were recorded."},
		Decisions: []string{"Used transactional task claims."},
	}

	artifact, err := writer.Write(context.Background(), report)
	if err != nil {
		t.Fatalf("Write returned error: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(root, artifact.RelativePath))
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}

	content := string(raw)
	for _, section := range []string{
		"## Task ID",
		"## Goal",
		"## Acceptance Criteria",
		"## Execution Result",
		"## Execution Metadata",
		"## Execution Contract",
		"## Policy Snapshot",
		"## Partial Execution",
		"## Reasoning Summary",
		"## Confidence Signals",
		"## Safety Checks",
		"## Detected Anomalies",
		"## Root Cause Hints",
		"## Retry Guidance",
		"## Retry Suggestions",
		"## Validation Summary",
		"## Attempt History",
		"## Structured JSON Result",
		"## Telemetry",
		"## Files Changed",
		"## Commands Run",
		"## Results",
		"## Findings",
		"## Decisions",
	} {
		if !strings.Contains(content, section) {
			t.Fatalf("expected artifact to contain %q, got:\n%s", section, content)
		}
	}
}
