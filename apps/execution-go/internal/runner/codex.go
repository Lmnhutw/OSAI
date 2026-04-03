package runner

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"execution-go/internal/cli"
)

type CodexRequest struct {
	WorkspacePath string
	TaskID        string
	BranchName    string
	Goal          string
	Prompt        string
	AttemptNo     int
}

type CodexRunner struct {
	command    string
	args       []string
	promptMode string
	timeout    time.Duration
	executor   *cli.Executor
}

func NewCodexRunner(command string, args []string, promptMode string, timeout time.Duration, executor *cli.Executor) *CodexRunner {
	return &CodexRunner{
		command:    command,
		args:       append([]string(nil), args...),
		promptMode: promptMode,
		timeout:    timeout,
		executor:   executor,
	}
}

func (r *CodexRunner) Run(ctx context.Context, req CodexRequest) (cli.Result, string, error) {
	promptDir := filepath.Join(req.WorkspacePath, ".execution")
	if err := os.MkdirAll(promptDir, 0o755); err != nil {
		return cli.Result{}, "", fmt.Errorf("create prompt directory: %w", err)
	}

	promptFile := filepath.Join(promptDir, fmt.Sprintf("codex-prompt-attempt-%d.md", req.AttemptNo))
	if err := os.WriteFile(promptFile, []byte(req.Prompt), 0o644); err != nil {
		return cli.Result{}, "", fmt.Errorf("write prompt file: %w", err)
	}

	args := make([]string, 0, len(r.args))
	for _, arg := range r.args {
		replaced := strings.NewReplacer(
			"{prompt_file}", promptFile,
			"{workspace}", req.WorkspacePath,
			"{task_id}", req.TaskID,
			"{branch}", req.BranchName,
			"{goal}", req.Goal,
		).Replace(arg)
		args = append(args, replaced)
	}

	commandCtx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()

	request := cli.Request{
		Label: "codex",
		Dir:   req.WorkspacePath,
		Name:  r.command,
		Args:  args,
		Env: []string{
			"CODEX_PROMPT_FILE=" + promptFile,
			"CODEX_TASK_ID=" + req.TaskID,
			"CODEX_BRANCH=" + req.BranchName,
		},
	}
	if r.promptMode == "stdin" {
		request.Stdin = req.Prompt
	}

	return r.executor.Run(commandCtx, request), promptFile, nil
}
