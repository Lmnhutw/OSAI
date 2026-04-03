package runner

import (
	"context"
	"fmt"
	"time"

	"execution-go/internal/cli"
)

type QualityRunner struct {
	timeout  time.Duration
	executor *cli.Executor
}

func NewQualityRunner(timeout time.Duration, executor *cli.Executor) *QualityRunner {
	return &QualityRunner{
		timeout:  timeout,
		executor: executor,
	}
}

func (r *QualityRunner) RunAll(ctx context.Context, workspacePath string, lintCommands, testCommands []string) []cli.Result {
	results := make([]cli.Result, 0, len(lintCommands)+len(testCommands))
	results = append(results, r.runGroup(ctx, workspacePath, "lint", lintCommands)...)
	results = append(results, r.runGroup(ctx, workspacePath, "test", testCommands)...)
	return results
}

func (r *QualityRunner) runGroup(ctx context.Context, workspacePath, kind string, commands []string) []cli.Result {
	results := make([]cli.Result, 0, len(commands))
	for i, command := range commands {
		commandCtx, cancel := context.WithTimeout(ctx, r.timeout)
		result := r.executor.Run(commandCtx, cli.Request{
			Label:        fmt.Sprintf("%s-%d", kind, i+1),
			Dir:          workspacePath,
			ShellCommand: command,
		})
		cancel()
		results = append(results, result)
	}
	return results
}
