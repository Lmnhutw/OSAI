package cli

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type Request struct {
	Label        string
	Dir          string
	Name         string
	Args         []string
	ShellCommand string
	Stdin        string
	Env          []string
}

type Result struct {
	Label       string
	CommandLine string
	Dir         string
	ExitCode    int
	Stdout      string
	Stderr      string
	Error       string
	TimedOut    bool
	StartedAt   time.Time
	FinishedAt  time.Time
	Duration    time.Duration
}

func (r Result) Success() bool {
	return !r.TimedOut && r.ExitCode == 0 && r.Error == ""
}

type Executor struct{}

func NewExecutor() *Executor {
	return &Executor{}
}

func (e *Executor) Run(ctx context.Context, req Request) Result {
	startedAt := time.Now()
	result := Result{
		Label:     req.Label,
		Dir:       req.Dir,
		StartedAt: startedAt,
		ExitCode:  -1,
	}

	var cmd *exec.Cmd
	if req.ShellCommand != "" {
		name, args := shellInvocation(req.ShellCommand)
		result.CommandLine = req.ShellCommand
		cmd = exec.CommandContext(ctx, name, args...)
	} else {
		result.CommandLine = formatCommand(req.Name, req.Args)
		cmd = exec.CommandContext(ctx, req.Name, req.Args...)
	}

	if req.Dir != "" {
		cmd.Dir = req.Dir
	}

	cmd.Env = append(os.Environ(), req.Env...)

	if req.Stdin != "" {
		cmd.Stdin = strings.NewReader(req.Stdin)
	}

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	result.Stdout = stdout.String()
	result.Stderr = stderr.String()
	result.FinishedAt = time.Now()
	result.Duration = result.FinishedAt.Sub(startedAt)

	if err == nil {
		result.ExitCode = 0
		return result
	}

	result.Error = err.Error()

	if ctx.Err() == context.DeadlineExceeded {
		result.TimedOut = true
		return result
	}

	if exitErr, ok := err.(*exec.ExitError); ok {
		result.ExitCode = exitErr.ExitCode()
		return result
	}

	return result
}

func shellInvocation(command string) (string, []string) {
	if runtime.GOOS == "windows" {
		return "powershell.exe", []string{"-NoProfile", "-Command", command}
	}
	return "/bin/sh", []string{"-lc", command}
}

func formatCommand(name string, args []string) string {
	if len(args) == 0 {
		return name
	}
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, quoteIfNeeded(name))
	for _, arg := range args {
		parts = append(parts, quoteIfNeeded(arg))
	}
	return strings.Join(parts, " ")
}

func quoteIfNeeded(value string) string {
	if value == "" {
		return `""`
	}
	if strings.ContainsAny(value, " \t\"") {
		return strconv.Quote(value)
	}
	return value
}
