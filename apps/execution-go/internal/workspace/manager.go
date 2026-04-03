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
	TaskID     string
	IssueKey   string
	Goal       string
	RepoSource string
	BaseBranch string
	BranchName string
}

type Workspace struct {
	Path       string
	RepoSource string
	BaseBranch string
	BranchName string
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

	name := sanitize(firstNonEmpty(req.IssueKey, req.TaskID))
	if name == "" {
		name = "task"
	}
	workspacePath := filepath.Join(m.root, fmt.Sprintf("%s-%d", name, time.Now().UTC().Unix()))

	commands := make([]cli.Result, 0, 2)

	cloneArgs := []string{"clone"}
	if strings.TrimSpace(req.BaseBranch) != "" {
		cloneArgs = append(cloneArgs, "--branch", req.BaseBranch, "--single-branch")
	}
	cloneArgs = append(cloneArgs, repoSource, workspacePath)

	cloneResult := m.runGit(ctx, "", "git clone", cloneArgs...)
	commands = append(commands, cloneResult)
	if !cloneResult.Success() {
		return Workspace{}, commands, fmt.Errorf("git clone failed: %s", summarizeResult(cloneResult))
	}

	checkoutResult := m.runGit(ctx, workspacePath, "git checkout -b", "checkout", "-b", req.BranchName)
	commands = append(commands, checkoutResult)
	if !checkoutResult.Success() {
		return Workspace{}, commands, fmt.Errorf("git checkout -b failed: %s", summarizeResult(checkoutResult))
	}

	return Workspace{
		Path:       workspacePath,
		RepoSource: repoSource,
		BaseBranch: req.BaseBranch,
		BranchName: req.BranchName,
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
		if len(line) > 3 {
			files = append(files, strings.TrimSpace(line[3:]))
			continue
		}
		files = append(files, line)
	}

	return files, result
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
