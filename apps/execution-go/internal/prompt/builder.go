package prompt

import (
	"strconv"
	"strings"
)

type Input struct {
	TaskID                  string
	JiraIssueKey            string
	Title                   string
	Goal                    string
	ExecutionIndex          int
	RetryCount              int
	FailurePatternHint      string
	Instructions            string
	WorkingDirectory        string
	BranchName              string
	AcceptanceCriteria      []string
	AllowedPaths            []string
	AdditionalInstructions  []string
	PreviousAttemptFindings []string
	ExecutionMode           string
	ContractActions         []string
	AutonomyReasoningRef    string
}

func Build(input Input) string {
	var builder strings.Builder

	builder.WriteString("# Codex Execution Task\n\n")
	writeField(&builder, "Task ID", input.TaskID)
	writeField(&builder, "Jira Issue", input.JiraIssueKey)
	writeField(&builder, "Title", input.Title)
	writeField(&builder, "Goal", input.Goal)
	if input.ExecutionIndex > 0 {
		writeField(&builder, "Execution Index", strconv.Itoa(input.ExecutionIndex))
	}
	writeField(&builder, "Retry Count", strconv.Itoa(max(0, input.RetryCount)))
	writeField(&builder, "Branch", input.BranchName)
	writeField(&builder, "Working Directory", emptyAs(input.WorkingDirectory, "."))
	writeField(&builder, "Execution Mode", input.ExecutionMode)

	builder.WriteString("\n## Instructions\n\n")
	builder.WriteString(strings.TrimSpace(input.Instructions))
	builder.WriteString("\n")

	builder.WriteString("\n## Acceptance Criteria\n\n")
	writeList(&builder, input.AcceptanceCriteria, "- No explicit acceptance criteria were provided.")

	builder.WriteString("\n## Constraints\n\n")
	if len(input.AllowedPaths) > 0 {
		writeList(&builder, prefixAll(input.AllowedPaths, "Only modify: "), "- Stay within the checked-out workspace.")
	} else {
		builder.WriteString("- Stay within the checked-out workspace.\n")
	}
	builder.WriteString("- Run the requested lint/test commands before finishing.\n")
	builder.WriteString("- Leave the repository ready for review.\n")

	if len(input.ContractActions) > 0 || strings.TrimSpace(input.AutonomyReasoningRef) != "" {
		builder.WriteString("\n## Execution Contract\n\n")
		if len(input.ContractActions) > 0 {
			writeList(&builder, prefixAll(input.ContractActions, "Allowed worker action: "), "")
		}
		if strings.TrimSpace(input.AutonomyReasoningRef) != "" {
			builder.WriteString("- Autonomy reasoning reference: ")
			builder.WriteString(strings.TrimSpace(input.AutonomyReasoningRef))
			builder.WriteString("\n")
		}
	}

	if input.RetryCount > 0 || input.ExecutionIndex > 1 || strings.TrimSpace(input.FailurePatternHint) != "" {
		builder.WriteString("\n## Retry Context\n\n")
		retryLines := []string{
			"Treat this as a retry-aware execution and keep the change set narrow and verifiable.",
			"Do not repeat the same failure path without new evidence or a materially different fix.",
			"Be explicit about the root cause before claiming the task is complete.",
			"Use stricter validation discipline: focus on the exact failing commands and confirm they pass before finishing.",
		}
		if input.RetryCount > 0 {
			retryLines = append(retryLines, "Current retry count: "+strconv.Itoa(input.RetryCount))
		}
		if input.ExecutionIndex > 1 {
			retryLines = append(retryLines, "This task has been executed before; preserve prior work and avoid destructive resets.")
		}
		if hint := strings.TrimSpace(input.FailurePatternHint); hint != "" {
			retryLines = append(retryLines, "Prior failure pattern hint: "+hint)
		}
		writeList(&builder, retryLines, "")
	}

	if len(input.AdditionalInstructions) > 0 {
		builder.WriteString("\n## Additional Instructions\n\n")
		writeList(&builder, input.AdditionalInstructions, "")
	}

	if len(input.PreviousAttemptFindings) > 0 {
		builder.WriteString("\n## Previous Attempt Findings\n\n")
		writeList(&builder, input.PreviousAttemptFindings, "")
	}

	builder.WriteString("\n## Output Expectations\n\n")
	builder.WriteString("- Make the required code changes.\n")
	builder.WriteString("- Leave the repository in a testable state.\n")
	builder.WriteString("- Summarize what changed and any remaining risks.\n")
	if input.RetryCount > 0 {
		builder.WriteString("- Call out what changed relative to the previous failed attempt.\n")
	}

	return builder.String()
}

func writeField(builder *strings.Builder, key, value string) {
	if strings.TrimSpace(value) == "" {
		return
	}
	builder.WriteString("- ")
	builder.WriteString(key)
	builder.WriteString(": ")
	builder.WriteString(strings.TrimSpace(value))
	builder.WriteString("\n")
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
	if !wrote && fallback != "" {
		builder.WriteString(fallback)
		builder.WriteString("\n")
	}
}

func prefixAll(values []string, prefix string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, prefix+value)
	}
	return out
}

func emptyAs(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func max(left, right int) int {
	if left > right {
		return left
	}
	return right
}
