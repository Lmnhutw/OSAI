package artifact

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"execution-go/internal/cli"
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
