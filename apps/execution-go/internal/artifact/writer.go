package artifact

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"execution-go/internal/cli"
)

type Report struct {
	TaskID             string
	JiraIssueKey       string
	Goal               string
	AcceptanceCriteria []string
	FilesChanged       []string
	Commands           []cli.Result
	Results            []string
	Findings           []string
	Decisions          []string
}

type Artifact struct {
	AbsolutePath string
	RelativePath string
}

type Writer struct {
	root     string
	repoRoot string
}

func NewWriter(root, repoRoot string) *Writer {
	return &Writer{
		root:     root,
		repoRoot: repoRoot,
	}
}

func (w *Writer) Write(ctx context.Context, report Report) (Artifact, error) {
	if err := ctx.Err(); err != nil {
		return Artifact{}, err
	}

	now := time.Now().UTC()
	subdir := filepath.Join(w.root, now.Format("2006"), now.Format("01"), now.Format("02"))
	if err := os.MkdirAll(subdir, 0o755); err != nil {
		return Artifact{}, fmt.Errorf("create artifact directory: %w", err)
	}

	fileName := fmt.Sprintf("%s-%s.md", sanitize(report.TaskID), now.Format("150405"))
	path := filepath.Join(subdir, fileName)

	if err := os.WriteFile(path, []byte(render(report)), 0o644); err != nil {
		return Artifact{}, fmt.Errorf("write artifact: %w", err)
	}

	relativePath := path
	if w.repoRoot != "" {
		if rel, err := filepath.Rel(w.repoRoot, path); err == nil {
			relativePath = rel
		}
	}

	return Artifact{
		AbsolutePath: path,
		RelativePath: relativePath,
	}, nil
}

func render(report Report) string {
	var builder strings.Builder

	builder.WriteString("# Execution Artifact\n\n")
	builder.WriteString("## Task ID\n\n")
	builder.WriteString(fallback(report.TaskID, "unknown"))
	builder.WriteString("\n\n")

	builder.WriteString("## Goal\n\n")
	builder.WriteString(fallback(report.Goal, "No goal provided."))
	builder.WriteString("\n\n")

	builder.WriteString("## Acceptance Criteria\n\n")
	writeList(&builder, report.AcceptanceCriteria, "- No explicit acceptance criteria were provided.")
	builder.WriteString("\n## Files Changed\n\n")
	writeList(&builder, report.FilesChanged, "- No tracked file changes were detected.")
	builder.WriteString("\n## Commands Run\n\n")

	if len(report.Commands) == 0 {
		builder.WriteString("- No commands were executed.\n")
	} else {
		for _, command := range report.Commands {
			builder.WriteString("### ")
			builder.WriteString(fallback(command.Label, "command"))
			builder.WriteString("\n\n")
			builder.WriteString("- Command: `")
			builder.WriteString(strings.TrimSpace(command.CommandLine))
			builder.WriteString("`\n")
			builder.WriteString("- Directory: `")
			builder.WriteString(fallback(command.Dir, "."))
			builder.WriteString("`\n")
			builder.WriteString("- Exit Code: ")
			builder.WriteString(fmt.Sprintf("%d", command.ExitCode))
			builder.WriteString("\n")
			builder.WriteString("- Duration: ")
			builder.WriteString(command.Duration.String())
			builder.WriteString("\n")
			builder.WriteString("- Timed Out: ")
			builder.WriteString(fmt.Sprintf("%t", command.TimedOut))
			builder.WriteString("\n")

			if out := trimOutput(command.Stdout); out != "" {
				builder.WriteString("\n#### stdout\n\n```text\n")
				builder.WriteString(out)
				if !strings.HasSuffix(out, "\n") {
					builder.WriteString("\n")
				}
				builder.WriteString("```\n")
			}

			if out := trimOutput(command.Stderr); out != "" {
				builder.WriteString("\n#### stderr\n\n```text\n")
				builder.WriteString(out)
				if !strings.HasSuffix(out, "\n") {
					builder.WriteString("\n")
				}
				builder.WriteString("```\n")
			}
		}
	}

	builder.WriteString("\n## Results\n\n")
	writeList(&builder, report.Results, "- No results were recorded.")
	builder.WriteString("\n## Findings\n\n")
	writeList(&builder, report.Findings, "- No findings were recorded.")
	builder.WriteString("\n## Decisions\n\n")
	writeList(&builder, report.Decisions, "- No decisions were recorded.")

	if strings.TrimSpace(report.JiraIssueKey) != "" {
		builder.WriteString("\n## Jira Issue\n\n")
		builder.WriteString(report.JiraIssueKey)
		builder.WriteString("\n")
	}

	return builder.String()
}

func writeList(builder *strings.Builder, values []string, fallback string) {
	wrote := false
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		builder.WriteString("- ")
		builder.WriteString(value)
		builder.WriteString("\n")
		wrote = true
	}
	if !wrote {
		builder.WriteString(fallback)
		builder.WriteString("\n")
	}
}

func sanitize(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "task"
	}
	replacer := strings.NewReplacer("/", "-", "\\", "-", " ", "-", "_", "-")
	return replacer.Replace(value)
}

func fallback(value, fallbackValue string) string {
	if strings.TrimSpace(value) == "" {
		return fallbackValue
	}
	return value
}

func trimOutput(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	const max = 4000
	if len(value) <= max {
		return value
	}
	return value[:max] + "\n...[truncated]"
}
