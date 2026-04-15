package workspace

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"execution-go/internal/cli"
)

func TestCleanupRemovesRunRootWithinWorkspaceRoot(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	runRoot := filepath.Join(root, "task-exec-001-retry-00-run")
	if err := os.MkdirAll(filepath.Join(runRoot, "repo"), 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}

	manager := NewManager(root, "", 0, cli.NewExecutor())
	result, err := manager.Cleanup(context.Background(), Workspace{RootPath: runRoot, Path: filepath.Join(runRoot, "repo")})
	if err != nil {
		t.Fatalf("Cleanup returned error: %v", err)
	}
	if !result.Success() {
		t.Fatalf("expected cleanup result to succeed, got %+v", result)
	}
	if _, statErr := os.Stat(runRoot); !os.IsNotExist(statErr) {
		t.Fatalf("expected run root to be removed, got stat err %v", statErr)
	}
}

func TestCleanupRejectsWorkspaceRootItself(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	manager := NewManager(root, "", 0, cli.NewExecutor())
	_, err := manager.Cleanup(context.Background(), Workspace{RootPath: root})
	if err == nil {
		t.Fatal("expected cleanup to reject removing the workspace root itself")
	}
}

func TestRunRootIncludesExecutionMetadata(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	manager := NewManager(root, "", 0, cli.NewExecutor())
	path := manager.runRoot(PrepareRequest{
		TaskID:         "task-1",
		IssueKey:       "OPS-1",
		RunID:          "1234567890abcdef",
		ExecutionIndex: 3,
		RetryCount:     2,
	})

	if !strings.Contains(path, "exec-003") {
		t.Fatalf("expected run root to contain execution index, got %q", path)
	}
	if !strings.Contains(path, "retry-02") {
		t.Fatalf("expected run root to contain retry count, got %q", path)
	}
	if !strings.Contains(path, "1234567890ab") {
		t.Fatalf("expected run root to contain shortened run id, got %q", path)
	}
}

func TestResolveWithinRootRejectsEscapingPath(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	if _, err := ResolveWithinRoot(root, "..\\outside"); err == nil {
		t.Fatal("expected ResolveWithinRoot to reject a path that escapes the workspace root")
	}
}
