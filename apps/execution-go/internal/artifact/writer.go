package artifact

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"execution-go/internal/cli"
	execresult "execution-go/internal/result"
)

type Report struct {
	TaskID             string
	JiraIssueKey       string
	Goal               string
	AcceptanceCriteria []string
	Execution          *execresult.ExecutionResult
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

	fileName := artifactFileName(report, now)
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
	if report.Execution != nil {
		builder.WriteString("\n## Execution Result\n\n")
		builder.WriteString("- Status: ")
		builder.WriteString(string(report.Execution.Status))
		builder.WriteString("\n")
		builder.WriteString("- Confidence: ")
		builder.WriteString(string(report.Execution.Confidence.Level))
		builder.WriteString(" (")
		builder.WriteString(fmt.Sprintf("%.2f", report.Execution.Confidence.Score))
		builder.WriteString(")\n")
		builder.WriteString("- Attempts: ")
		builder.WriteString(fmt.Sprintf("%d", report.Execution.AttemptCount))
		builder.WriteString("\n")
		builder.WriteString("- Execution Index: ")
		builder.WriteString(fmt.Sprintf("%d", report.Execution.Metadata.ExecutionIndex))
		builder.WriteString("\n")
		builder.WriteString("- Retry Count: ")
		builder.WriteString(fmt.Sprintf("%d", report.Execution.Metadata.RetryCount))
		builder.WriteString("\n")
		builder.WriteString("- Evaluation State: ")
		builder.WriteString(fallback(report.Execution.Evaluation.State, "unknown"))
		builder.WriteString("\n")
		if strings.TrimSpace(string(report.Execution.FailureClassification)) != "" {
			builder.WriteString("- Failure Classification: ")
			builder.WriteString(string(report.Execution.FailureClassification))
			builder.WriteString("\n")
		}
		if strings.TrimSpace(string(report.Execution.FailureType)) != "" {
			builder.WriteString("- Failure Type: ")
			builder.WriteString(string(report.Execution.FailureType))
			builder.WriteString("\n")
		}
		if strings.TrimSpace(report.Execution.FailureReason) != "" {
			builder.WriteString("- Failure Reason: ")
			builder.WriteString(report.Execution.FailureReason)
			builder.WriteString("\n")
		}

		builder.WriteString("\n## Execution Metadata\n\n")
		metadataLines := []string{
			fmt.Sprintf("Run ID: %s", fallback(report.Execution.Metadata.RunID, "unknown")),
			fmt.Sprintf("Execution index: %d", report.Execution.Metadata.ExecutionIndex),
			fmt.Sprintf("Retry count: %d", report.Execution.Metadata.RetryCount),
			fmt.Sprintf("Branch name: %s", fallback(report.Execution.Metadata.BranchName, "unknown")),
			fmt.Sprintf("Branch strategy: %s", fallback(report.Execution.Metadata.BranchStrategy, "unknown")),
			fmt.Sprintf("Workspace cleaned: %t", report.Execution.Metadata.WorkspaceCleaned),
		}
		if strings.TrimSpace(report.Execution.Metadata.FailurePatternHint) != "" {
			metadataLines = append(metadataLines, "Failure pattern hint: "+report.Execution.Metadata.FailurePatternHint)
		}
		writeList(&builder, metadataLines, "- No execution metadata was recorded.")

		builder.WriteString("\n## Partial Execution\n\n")
		partialLines := []string{
			fmt.Sprintf("Early exit: %t", report.Execution.Partial.EarlyExit),
			fmt.Sprintf("Incomplete implementation: %t", report.Execution.Partial.IncompleteImplementation),
		}
		if strings.TrimSpace(report.Execution.Partial.ReasonCode) != "" {
			partialLines = append(partialLines, "Reason code: "+report.Execution.Partial.ReasonCode)
		}
		if strings.TrimSpace(report.Execution.Partial.Reason) != "" {
			partialLines = append(partialLines, "Reason: "+report.Execution.Partial.Reason)
		}
		writeList(&builder, partialLines, "- No partial execution details were recorded.")

		builder.WriteString("\n## Reasoning Summary\n\n")
		builder.WriteString(fallback(report.Execution.ReasoningSummary, "No reasoning summary was recorded."))
		builder.WriteString("\n")

		builder.WriteString("\n## Confidence Signals\n\n")
		writeList(&builder, report.Execution.Confidence.Signals, "- No confidence signals were recorded.")

		builder.WriteString("\n## Detected Anomalies\n\n")
		writeList(&builder, report.Execution.DetectedAnomalies, "- No anomalies were detected.")

		builder.WriteString("\n## Root Cause Hints\n\n")
		writeList(&builder, report.Execution.RootCauseHints, "- No root cause hints were recorded.")

		builder.WriteString("\n## Retry Guidance\n\n")
		retryLines := []string{
			fmt.Sprintf("Eligible: %t", report.Execution.Retry.Eligible),
			fmt.Sprintf("Remaining attempts: %d", report.Execution.Retry.Remaining),
			fmt.Sprintf("Max attempts: %d", report.Execution.Retry.MaxAttempts),
		}
		if strings.TrimSpace(report.Execution.Retry.Reason) != "" {
			retryLines = append(retryLines, "Reason: "+report.Execution.Retry.Reason)
		}
		if report.Execution.Retry.RepeatedFailurePattern {
			retryLines = append(retryLines, "Repeated failure pattern detected.")
		}
		retryLines = append(retryLines, report.Execution.Retry.Suggestions...)
		writeList(&builder, retryLines, "- No retry guidance was recorded.")

		builder.WriteString("\n## Retry Suggestions\n\n")
		writeList(&builder, report.Execution.RetrySuggestions, "- No retry suggestions were recorded.")

		builder.WriteString("\n## Validation Summary\n\n")
		validationLines := []string{
			fmt.Sprintf("Total commands: %d", report.Execution.Validation.Total),
			fmt.Sprintf("Passed: %d", report.Execution.Validation.Passed),
			fmt.Sprintf("Failed: %d", report.Execution.Validation.Failed),
			fmt.Sprintf("Lint passed: %d/%d", report.Execution.Validation.LintPassed, report.Execution.Validation.LintTotal),
			fmt.Sprintf("Tests passed: %d/%d", report.Execution.Validation.TestPassed, report.Execution.Validation.TestTotal),
		}
		writeList(&builder, validationLines, "- No validation summary was recorded.")

		builder.WriteString("\n## Attempt History\n\n")
		if len(report.Execution.History) == 0 {
			builder.WriteString("- No attempt history was recorded.\n")
		} else {
			for _, attempt := range report.Execution.History {
				builder.WriteString("### Attempt ")
				builder.WriteString(fmt.Sprintf("%d", attempt.AttemptNo))
				builder.WriteString("\n\n")
				attemptLines := []string{
					fmt.Sprintf("Retry count: %d", attempt.RetryCount),
					fmt.Sprintf("Status: %s", attempt.Status),
					fmt.Sprintf("Summary: %s", fallback(attempt.Summary, "n/a")),
				}
				if strings.TrimSpace(string(attempt.FailureType)) != "" {
					attemptLines = append(attemptLines, "Failure type: "+string(attempt.FailureType))
				}
				if strings.TrimSpace(attempt.FailureReason) != "" {
					attemptLines = append(attemptLines, "Failure reason: "+attempt.FailureReason)
				}
				attemptLines = append(attemptLines, attempt.RootCauseHints...)
				writeList(&builder, attemptLines, "- No attempt details were recorded.")
				builder.WriteString("\n")
			}
		}

		builder.WriteString("\n## Structured JSON Result\n\n```json\n")
		builder.WriteString(renderJSON(report.Execution))
		builder.WriteString("\n```\n")
	}
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

func renderJSON(value any) string {
	payload, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return "{}"
	}
	return string(payload)
}

func artifactFileName(report Report, now time.Time) string {
	base := sanitize(report.TaskID)
	if report.Execution == nil {
		return fmt.Sprintf("%s-%s.md", base, now.Format("150405"))
	}

	executionIndex := report.Execution.Metadata.ExecutionIndex
	if executionIndex < 1 {
		executionIndex = 1
	}
	retryCount := report.Execution.Metadata.RetryCount
	if retryCount < 0 {
		retryCount = 0
	}

	runToken := sanitize(report.Execution.Metadata.RunID)
	if len(runToken) > 10 {
		runToken = runToken[:10]
	}
	if runToken == "" {
		return fmt.Sprintf("%s-exec-%03d-retry-%02d-%s.md", base, executionIndex, retryCount, now.Format("150405"))
	}
	return fmt.Sprintf("%s-exec-%03d-retry-%02d-%s-%s.md", base, executionIndex, retryCount, runToken, now.Format("150405"))
}
