package prompt

import "strings"

type Input struct {
	TaskID                  string
	JiraIssueKey            string
	Title                   string
	Goal                    string
	Instructions            string
	WorkingDirectory        string
	BranchName              string
	AcceptanceCriteria      []string
	AllowedPaths            []string
	AdditionalInstructions  []string
	PreviousAttemptFindings []string
}

func Build(input Input) string {
	var builder strings.Builder

	builder.WriteString("# Codex Execution Task\n\n")
	writeField(&builder, "Task ID", input.TaskID)
	writeField(&builder, "Jira Issue", input.JiraIssueKey)
	writeField(&builder, "Title", input.Title)
	writeField(&builder, "Goal", input.Goal)
	writeField(&builder, "Branch", input.BranchName)
	writeField(&builder, "Working Directory", emptyAs(input.WorkingDirectory, "."))

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
