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
			FailureReason:         "test-1 failed with exit code 1",
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
			CompletedAt:  time.Now().UTC(),
		},
		FilesChanged:       []string{"internal/worker/service.go"},
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
		"## Reasoning Summary",
		"## Confidence Signals",
		"## Detected Anomalies",
		"## Retry Guidance",
		"## Validation Summary",
		"## Structured JSON Result",
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
