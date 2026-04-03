package prompt

import (
	"strings"
	"testing"
)

func TestBuildIncludesRetryContext(t *testing.T) {
	t.Parallel()

	output := Build(Input{
		TaskID:                  "task-1",
		JiraIssueKey:            "OPS-99",
		Title:                   "Build execution worker",
		Goal:                    "Implement the Go execution worker",
		Instructions:            "Create the required packages and tests.",
		WorkingDirectory:        "apps/execution-go",
		BranchName:              "codex/ops-99-worker",
		AcceptanceCriteria:      []string{"Poll Jira", "Write artifacts"},
		AllowedPaths:            []string{"apps/execution-go"},
		AdditionalInstructions:  []string{"Do not touch Python services."},
		PreviousAttemptFindings: []string{"lint-1 failed with exit code 1"},
	})

	for _, expected := range []string{
		"# Codex Execution Task",
		"## Instructions",
		"## Acceptance Criteria",
		"## Previous Attempt Findings",
		"lint-1 failed with exit code 1",
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("expected prompt to contain %q, got:\n%s", expected, output)
		}
	}
}
