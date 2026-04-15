package workspace

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"execution-go/internal/cli"
)

type PrepareRequest struct {
	TaskID         string
	IssueKey       string
	Goal           string
	RepoSource     string
	BaseBranch     string
	BranchName     string
	RunID          string
	ExecutionIndex int
	RetryCount     int
}

type Workspace struct {
	RootPath       string
	Path           string
	MetadataPath   string
	RepoSource     string
	BaseBranch     string
	BranchName     string
	BranchStrategy string
	RunID          string
	ExecutionIndex int
	RetryCount     int
}

type Manager struct {
	root              string
	defaultRepoSource string
	gitTimeout        time.Duration
	executor          *cli.Executor
}

func NewManager(root, defaultRepoSource string, gitTimeout time.Duration, executor *cli.Executor) *Manager {
	return &Manager{
		root:              root,
		defaultRepoSource: defaultRepoSource,
		gitTimeout:        gitTimeout,
		executor:          executor,
	}
}

func (m *Manager) Prepare(ctx context.Context, req PrepareRequest) (Workspace, []cli.Result, error) {
	repoSource := strings.TrimSpace(req.RepoSource)
	if repoSource == "" {
		repoSource = m.defaultRepoSource
	}
	if repoSource == "" {
		return Workspace{}, nil, fmt.Errorf("no repository source configured for task %s", req.TaskID)
	}

	if err := os.MkdirAll(m.root, 0o755); err != nil {
		return Workspace{}, nil, fmt.Errorf("create workspace root: %w", err)
	}

	runRoot := m.runRoot(req)
	commands := make([]cli.Result, 0, 6)

	if info, err := os.Stat(runRoot); err == nil && info.IsDir() {
		cleanupResult, cleanupErr := m.cleanupPath(runRoot)
		commands = append(commands, cleanupResult)
		if cleanupErr != nil {
			return Workspace{}, commands, fmt.Errorf("reset stale workspace: %w", cleanupErr)
		}
	}

	if err := os.MkdirAll(runRoot, 0o755); err != nil {
		return Workspace{}, commands, fmt.Errorf("create run root: %w", err)
	}

	repoPath := filepath.Join(runRoot, "repo")
	metadataPath := filepath.Join(runRoot, ".execution")
	if err := os.MkdirAll(metadataPath, 0o755); err != nil {
		return Workspace{}, commands, fmt.Errorf("create execution metadata directory: %w", err)
	}

	cloneArgs := []string{"clone"}
	if strings.TrimSpace(req.BaseBranch) != "" {
		cloneArgs = append(cloneArgs, "--branch", req.BaseBranch, "--single-branch")
	}
	cloneArgs = append(cloneArgs, repoSource, repoPath)

	cloneResult := m.runGit(ctx, "", "git clone", cloneArgs...)
	commands = append(commands, cloneResult)
	if !cloneResult.Success() {
		return Workspace{}, commands, fmt.Errorf("git clone failed: %s", summarizeResult(cloneResult))
	}

	branchStrategy := "created_from_base"
	if strings.TrimSpace(req.BranchName) != "" {
		startPoint := ""
		lsRemoteResult := m.runGit(ctx, repoPath, "git ls-remote --heads", "ls-remote", "--heads", "origin", req.BranchName)
		commands = append(commands, lsRemoteResult)
		if lsRemoteResult.Success() && strings.TrimSpace(lsRemoteResult.Stdout) != "" {
			fetchResult := m.runGit(ctx, repoPath, "git fetch origin", "fetch", "origin", req.BranchName)
			commands = append(commands, fetchResult)
			if fetchResult.Success() {
				startPoint = "FETCH_HEAD"
				branchStrategy = "reused_remote_branch"
			} else {
				branchStrategy = "regenerated_from_base"
			}
		}

		checkoutArgs := []string{"checkout", "-B", req.BranchName}
		if startPoint != "" {
			checkoutArgs = append(checkoutArgs, startPoint)
		}
		checkoutResult := m.runGit(ctx, repoPath, "git checkout -B", checkoutArgs...)
		commands = append(commands, checkoutResult)
		if !checkoutResult.Success() {
			return Workspace{}, commands, fmt.Errorf("git checkout -B failed: %s", summarizeResult(checkoutResult))
		}
	}

	return Workspace{
		RootPath:       runRoot,
		Path:           repoPath,
		MetadataPath:   metadataPath,
		RepoSource:     repoSource,
		BaseBranch:     req.BaseBranch,
		BranchName:     req.BranchName,
		BranchStrategy: branchStrategy,
		RunID:          strings.TrimSpace(req.RunID),
		ExecutionIndex: max(req.ExecutionIndex, 1),
		RetryCount:     max(req.RetryCount, 0),
	}, commands, nil
}

func (m *Manager) ChangedFiles(ctx context.Context, workspacePath string) ([]string, cli.Result) {
	result := m.runGit(ctx, workspacePath, "git status --short", "status", "--short")
	if !result.Success() {
		return nil, result
	}

	lines := strings.Split(result.Stdout, "\n")
	files := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		path := line
		if len(line) > 3 {
			path = strings.TrimSpace(line[3:])
		}
		if isInternalExecutionPath(path) {
			continue
		}
		files = append(files, path)
	}

	return files, result
}

func (m *Manager) Cleanup(ctx context.Context, ws Workspace) (cli.Result, error) {
	target := strings.TrimSpace(ws.RootPath)
	if target == "" {
		target = strings.TrimSpace(ws.Path)
		if target != "" {
			target = filepath.Dir(target)
		}
	}

	startedAt := time.Now()
	result := cli.Result{
		Label:      "workspace cleanup",
		Dir:        target,
		StartedAt:  startedAt,
		FinishedAt: startedAt,
		ExitCode:   -1,
	}
	if target == "" {
		result.Error = "workspace cleanup target is empty"
		return result, fmt.Errorf("workspace cleanup target is empty")
	}

	if err := ctx.Err(); err != nil {
		result.Error = err.Error()
		return result, err
	}

	cleanupResult, cleanupErr := m.cleanupPath(target)
	if strings.TrimSpace(cleanupResult.Label) == "" {
		cleanupResult.Label = "workspace cleanup"
	}
	cleanupResult.StartedAt = startedAt
	cleanupResult.FinishedAt = time.Now()
	cleanupResult.Duration = cleanupResult.FinishedAt.Sub(startedAt)
	return cleanupResult, cleanupErr
}

func (m *Manager) runGit(parent context.Context, dir, label string, args ...string) cli.Result {
	ctx, cancel := context.WithTimeout(parent, m.gitTimeout)
	defer cancel()
	return m.executor.Run(ctx, cli.Request{
		Label: label,
		Dir:   dir,
		Name:  "git",
		Args:  args,
	})
}

func (m *Manager) runRoot(req PrepareRequest) string {
	name := sanitize(firstNonEmpty(req.IssueKey, req.TaskID))
	if name == "" {
		name = "task"
	}
	runID := sanitize(shortToken(firstNonEmpty(req.RunID, "run")))
	if runID == "" {
		runID = "run"
	}

	return filepath.Join(
		m.root,
		fmt.Sprintf(
			"%s-exec-%03d-retry-%02d-%s",
			name,
			max(req.ExecutionIndex, 1),
			max(req.RetryCount, 0),
			runID,
		),
	)
}

func (m *Manager) cleanupPath(target string) (cli.Result, error) {
	startedAt := time.Now()
	result := cli.Result{
		Label:       "workspace cleanup",
		Dir:         target,
		CommandLine: "cleanup workspace",
		StartedAt:   startedAt,
		ExitCode:    -1,
	}

	if err := m.ensureWithinRoot(target); err != nil {
		result.Error = err.Error()
		result.FinishedAt = time.Now()
		result.Duration = result.FinishedAt.Sub(startedAt)
		return result, err
	}

	if err := os.RemoveAll(target); err != nil {
		result.Error = err.Error()
		result.FinishedAt = time.Now()
		result.Duration = result.FinishedAt.Sub(startedAt)
		return result, fmt.Errorf("remove workspace: %w", err)
	}

	result.ExitCode = 0
	result.FinishedAt = time.Now()
	result.Duration = result.FinishedAt.Sub(startedAt)
	return result, nil
}

func (m *Manager) ensureWithinRoot(target string) error {
	rel, err := relativeWithinRoot(m.root, target)
	if err != nil {
		return err
	}
	if rel == "." || rel == "" {
		targetAbs, _ := filepath.Abs(target)
		return fmt.Errorf("refusing to remove path outside workspace root: %s", targetAbs)
	}
	return nil
}

func ResolveWithinRoot(root, relativePath string) (string, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve workspace root: %w", err)
	}

	resolved := rootAbs
	if strings.TrimSpace(relativePath) != "" && strings.TrimSpace(relativePath) != "." {
		resolved = filepath.Join(rootAbs, relativePath)
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return "", fmt.Errorf("resolve workspace path: %w", err)
	}

	rel, err := relativeWithinRoot(rootAbs, resolved)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", fmt.Errorf("path escapes workspace root: %s", resolved)
	}
	return resolved, nil
}

func relativeWithinRoot(root, target string) (string, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve workspace root: %w", err)
	}
	targetAbs, err := filepath.Abs(target)
	if err != nil {
		return "", fmt.Errorf("resolve workspace path: %w", err)
	}

	rel, err := filepath.Rel(rootAbs, targetAbs)
	if err != nil {
		return "", fmt.Errorf("compare workspace path: %w", err)
	}
	if strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", fmt.Errorf("refusing to access path outside workspace root: %s", targetAbs)
	}
	return rel, nil
}

func isInternalExecutionPath(path string) bool {
	normalized := strings.Trim(strings.ReplaceAll(path, "\\", "/"), "/")
	return normalized == ".execution" ||
		strings.HasPrefix(normalized, ".execution/") ||
		normalized == ".git" ||
		strings.HasPrefix(normalized, ".git/")
}

func sanitize(value string) string {
	value = strings.ToLower(value)
	replacer := strings.NewReplacer("/", "-", "\\", "-", " ", "-", "_", "-", ":", "-", ".", "-")
	value = replacer.Replace(value)

	var builder strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
			builder.WriteRune(r)
		case r >= '0' && r <= '9':
			builder.WriteRune(r)
		case r == '-':
			builder.WriteRune(r)
		}
	}

	return strings.Trim(builder.String(), "-")
}

func shortToken(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= 12 {
		return value
	}
	return value[:12]
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			return value
		}
	}
	return ""
}

func summarizeResult(result cli.Result) string {
	switch {
	case result.TimedOut:
		return "command timed out"
	case result.Error != "":
		return result.Error
	case strings.TrimSpace(result.Stderr) != "":
		return strings.TrimSpace(result.Stderr)
	default:
		return strings.TrimSpace(result.Stdout)
	}
}

func max(left, right int) int {
	if left > right {
		return left
	}
	return right
}
