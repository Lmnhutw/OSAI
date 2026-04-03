package worker

import (
	"fmt"
	"strings"

	"execution-go/internal/config"
	"execution-go/internal/jira"
	"execution-go/internal/store"
)

type ExecutionSpec struct {
	TaskID                 string
	JiraIssueKey           string
	Title                  string
	Goal                   string
	Instructions           string
	AcceptanceCriteria     []string
	AllowedPaths           []string
	AdditionalInstructions []string
	RepoSource             string
	BaseBranch             string
	BranchName             string
	WorkingDirectory       string
	LintCommands           []string
	TestCommands           []string
}

func BuildExecutionSpec(cfg config.Config, issue jira.Issue, task store.Task) ExecutionSpec {
	payload := task.InputPayload

	goal := firstString(
		lookupString(payload, "goal"),
		lookupString(payload, "summary"),
		issue.Summary,
		task.Title,
	)

	instructions := firstString(
		lookupString(payload, "instructions"),
		task.Instructions,
	)

	acceptanceCriteria := firstSlice(
		lookupStrings(payload, "acceptance_criteria"),
		lookupStrings(payload, "acceptanceCriteria"),
		lookupStrings(payload, "requirements"),
	)
	if len(acceptanceCriteria) == 0 && instructions != "" {
		acceptanceCriteria = []string{instructions}
	}

	branchName := firstString(
		lookupString(payload, "branch_name"),
		lookupString(payload, "branchName"),
		suggestBranch(issue.Key, goal),
	)

	return ExecutionSpec{
		TaskID:                 task.ID,
		JiraIssueKey:           firstString(issue.Key, lookupString(payload, "jira_issue_key"), lookupString(payload, "jira.issue_key"), lookupString(payload, "jira.issueKey")),
		Title:                  task.Title,
		Goal:                   goal,
		Instructions:           instructions,
		AcceptanceCriteria:     acceptanceCriteria,
		AllowedPaths:           firstSlice(lookupStrings(payload, "allowed_paths"), lookupStrings(payload, "allowedPaths"), lookupStrings(payload, "paths")),
		AdditionalInstructions: firstSlice(lookupStrings(payload, "codex_instructions"), lookupStrings(payload, "codexInstructions"), lookupStrings(payload, "extra_instructions")),
		RepoSource:             firstString(lookupString(payload, "repo_url"), lookupString(payload, "repository"), lookupString(payload, "repo.path"), cfg.DefaultRepoSource),
		BaseBranch:             firstString(lookupString(payload, "base_branch"), lookupString(payload, "baseBranch"), cfg.DefaultBaseBranch),
		BranchName:             branchName,
		WorkingDirectory:       firstString(lookupString(payload, "working_dir"), lookupString(payload, "workingDirectory"), cfg.DefaultWorkingDir),
		LintCommands:           firstSlice(lookupStrings(payload, "lint_commands"), lookupStrings(payload, "lintCommands"), cfg.DefaultLintCommands),
		TestCommands:           firstSlice(lookupStrings(payload, "test_commands"), lookupStrings(payload, "testCommands"), cfg.DefaultTestCommands),
	}
}

func lookupString(payload map[string]any, path string) string {
	value, ok := lookupValue(payload, path)
	if !ok {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case fmt.Stringer:
		return strings.TrimSpace(typed.String())
	default:
		return strings.TrimSpace(fmt.Sprintf("%v", typed))
	}
}

func lookupStrings(payload map[string]any, path string) []string {
	value, ok := lookupValue(payload, path)
	if !ok {
		return nil
	}
	switch typed := value.(type) {
	case []string:
		return cleanStrings(typed)
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			out = append(out, strings.TrimSpace(fmt.Sprintf("%v", item)))
		}
		return cleanStrings(out)
	case string:
		if strings.TrimSpace(typed) == "" {
			return nil
		}
		parts := strings.Split(strings.ReplaceAll(typed, "\r\n", "\n"), "\n")
		return cleanStrings(parts)
	default:
		return nil
	}
}

func lookupValue(payload map[string]any, path string) (any, bool) {
	current := any(payload)
	parts := strings.Split(path, ".")
	for _, part := range parts {
		asMap, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		value, exists := asMap[part]
		if !exists {
			return nil, false
		}
		current = value
	}
	return current, true
}

func firstString(values ...string) string {
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			return value
		}
	}
	return ""
}

func firstSlice(candidates ...[]string) []string {
	for _, candidate := range candidates {
		candidate = cleanStrings(candidate)
		if len(candidate) > 0 {
			return candidate
		}
	}
	return nil
}

func cleanStrings(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		out = append(out, value)
	}
	return out
}

func suggestBranch(issueKey, goal string) string {
	base := strings.ToLower(strings.TrimSpace(issueKey))
	if base == "" {
		base = "task"
	}

	slug := slugify(goal)
	if slug == "" {
		return "codex/" + base
	}
	return "codex/" + base + "-" + slug
}

func slugify(value string) string {
	value = strings.ToLower(value)
	value = strings.NewReplacer("/", "-", "\\", "-", "_", "-", " ", "-").Replace(value)

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

	slug := strings.Trim(builder.String(), "-")
	if len(slug) > 40 {
		slug = slug[:40]
	}
	return strings.Trim(slug, "-")
}
