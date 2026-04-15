package worker

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"execution-go/internal/config"
	"execution-go/internal/jira"
	execresult "execution-go/internal/result"
	"execution-go/internal/store"
)

type ExecutionSpec struct {
	TaskID                 string
	WorkerID               string
	JiraIssueKey           string
	RunID                  string
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
	RetryCount             int
	ExecutionIndex         int
	FailurePatternHint     string
	Contract               execresult.ExecutionContract
	PolicySnapshot         execresult.PolicySnapshot
}

func BuildExecutionSpec(cfg config.Config, issue jira.Issue, claimed *store.ClaimedTask) ExecutionSpec {
	task := claimed.Task
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

	retryCount := maxInt(
		claimed.RetryCount,
		lookupInt(payload, "retry_count"),
		lookupInt(payload, "retryCount"),
		lookupInt(payload, "loop.retry_count"),
		lookupInt(payload, "loop.retryCount"),
	)

	contract := parseExecutionContract(payload, task.ID)
	policySnapshot := parsePolicySnapshot(payload, contract.PolicyVersion)

	if strings.TrimSpace(contract.Branch.BaseBranch) != "" {
		cfg.DefaultBaseBranch = contract.Branch.BaseBranch
	}
	if strings.TrimSpace(contract.Branch.TargetBranch) != "" {
		branchName = contract.Branch.TargetBranch
	}
	if len(contract.Write.AllowedPaths) > 0 {
		acceptanceCriteria = cleanStrings(acceptanceCriteria)
	}

	return ExecutionSpec{
		TaskID:                 task.ID,
		WorkerID:               cfg.WorkerName,
		JiraIssueKey:           firstString(issue.Key, lookupString(payload, "jira_issue_key"), lookupString(payload, "jira.issue_key"), lookupString(payload, "jira.issueKey"), lookupString(payload, "jira.key")),
		RunID:                  claimed.RunID,
		Title:                  task.Title,
		Goal:                   goal,
		Instructions:           instructions,
		AcceptanceCriteria:     acceptanceCriteria,
		AllowedPaths:           firstSlice(contract.Write.AllowedPaths, lookupStrings(payload, "allowed_paths"), lookupStrings(payload, "allowedPaths"), lookupStrings(payload, "paths")),
		AdditionalInstructions: firstSlice(lookupStrings(payload, "codex_instructions"), lookupStrings(payload, "codexInstructions"), lookupStrings(payload, "extra_instructions")),
		RepoSource:             firstString(lookupString(payload, "repo_url"), lookupString(payload, "repository"), lookupString(payload, "repo.path"), cfg.DefaultRepoSource),
		BaseBranch:             firstString(contract.Branch.BaseBranch, lookupString(payload, "base_branch"), lookupString(payload, "baseBranch"), cfg.DefaultBaseBranch),
		BranchName:             branchName,
		WorkingDirectory:       firstString(lookupString(payload, "working_dir"), lookupString(payload, "workingDirectory"), cfg.DefaultWorkingDir),
		LintCommands:           firstSlice(lookupStrings(payload, "lint_commands"), lookupStrings(payload, "lintCommands"), cfg.DefaultLintCommands),
		TestCommands:           firstSlice(lookupStrings(payload, "test_commands"), lookupStrings(payload, "testCommands"), cfg.DefaultTestCommands),
		RetryCount:             retryCount,
		ExecutionIndex:         maxInt(1, claimed.ExecutionIndex),
		FailurePatternHint: firstString(
			claimed.FailurePatternHint,
			lookupString(payload, "failure_pattern_hint"),
			lookupString(payload, "failurePatternHint"),
			lookupString(payload, "loop.failure_pattern_hint"),
			lookupString(payload, "loop.failurePatternHint"),
		),
		Contract:       contract,
		PolicySnapshot: policySnapshot,
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

func lookupInt(payload map[string]any, path string) int {
	value, ok := lookupValue(payload, path)
	if !ok {
		return 0
	}

	switch typed := value.(type) {
	case int:
		return maxInt(0, typed)
	case int32:
		return maxInt(0, int(typed))
	case int64:
		return maxInt(0, int(typed))
	case float64:
		return maxInt(0, int(typed))
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		if err != nil {
			return 0
		}
		return maxInt(0, parsed)
	default:
		parsed, err := strconv.Atoi(strings.TrimSpace(fmt.Sprintf("%v", typed)))
		if err != nil {
			return 0
		}
		return maxInt(0, parsed)
	}
}

func lookupBool(payload map[string]any, path string) (bool, bool) {
	value, ok := lookupValue(payload, path)
	if !ok {
		return false, false
	}

	switch typed := value.(type) {
	case bool:
		return typed, true
	case string:
		switch strings.ToLower(strings.TrimSpace(typed)) {
		case "true", "1", "yes", "approved":
			return true, true
		case "false", "0", "no", "pending", "rejected":
			return false, true
		default:
			return false, false
		}
	case int:
		return typed != 0, true
	case int32:
		return typed != 0, true
	case int64:
		return typed != 0, true
	case float64:
		return typed != 0, true
	default:
		return false, false
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

func lookupMap(payload map[string]any, path string) map[string]any {
	value, ok := lookupValue(payload, path)
	if !ok {
		return nil
	}
	switch typed := value.(type) {
	case map[string]any:
		return typed
	case map[string]string:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = item
		}
		return out
	default:
		return nil
	}
}

func lookupTime(payload map[string]any, path string) *time.Time {
	raw := lookupString(payload, path)
	if raw == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if parsed, err := time.Parse(layout, raw); err == nil {
			parsed = parsed.UTC()
			return &parsed
		}
	}
	return nil
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

func firstBool(values ...boolValue) (bool, bool) {
	for _, value := range values {
		if !value.ok {
			continue
		}
		return value.value, true
	}
	return false, false
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

type boolValue struct {
	value bool
	ok    bool
}

func boolCandidate(value bool, ok bool) boolValue {
	return boolValue{value: value, ok: ok}
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

func maxInt(values ...int) int {
	best := 0
	for _, value := range values {
		if value > best {
			best = value
		}
	}
	return best
}

func parseExecutionContract(payload map[string]any, taskID string) execresult.ExecutionContract {
	contractPayload := firstMap(
		lookupMap(payload, "execution_contract"),
		lookupMap(payload, "executionContract"),
		lookupMap(payload, "execution.contract"),
		lookupMap(payload, "execution_payload.execution_contract"),
		lookupMap(payload, "execution.execution_contract"),
		lookupMap(payload, "execution.executionContract"),
	)
	if contractPayload == nil {
		return execresult.ExecutionContract{}
	}

	required, _ := firstBool(
		boolCandidate(lookupBool(contractPayload, "approval.required")),
		boolCandidate(lookupBool(contractPayload, "approval_required")),
	)
	approved, _ := firstBool(
		boolCandidate(lookupBool(contractPayload, "approval.approved")),
		boolCandidate(lookupBool(contractPayload, "approval.approved_status")),
		boolCandidate(lookupBool(contractPayload, "approval.approval_status")),
	)
	writeAllowed, _ := firstBool(
		boolCandidate(lookupBool(contractPayload, "write_permissions.allow_write")),
		boolCandidate(lookupBool(contractPayload, "write.allow_write")),
		boolCandidate(lookupBool(contractPayload, "write_permissions.allowWrite")),
	)
	readOnly, _ := firstBool(
		boolCandidate(lookupBool(contractPayload, "write_permissions.read_only")),
		boolCandidate(lookupBool(contractPayload, "write.read_only")),
		boolCandidate(lookupBool(contractPayload, "read_only")),
	)
	dryRun, _ := firstBool(
		boolCandidate(lookupBool(contractPayload, "write_permissions.dry_run")),
		boolCandidate(lookupBool(contractPayload, "write.dry_run")),
		boolCandidate(lookupBool(contractPayload, "dry_run")),
	)
	workspaceOnly, foundWorkspaceOnly := firstBool(
		boolCandidate(lookupBool(contractPayload, "write_permissions.workspace_only")),
		boolCandidate(lookupBool(contractPayload, "write.workspace_only")),
	)
	noAutonomousWrite, _ := firstBool(
		boolCandidate(lookupBool(contractPayload, "write_permissions.no_autonomous_write")),
		boolCandidate(lookupBool(contractPayload, "write.no_autonomous_write")),
		boolCandidate(lookupBool(contractPayload, "no_autonomous_write")),
	)
	retryAllowed, _ := firstBool(
		boolCandidate(lookupBool(contractPayload, "retry.allowed")),
		boolCandidate(lookupBool(contractPayload, "retry_allowed")),
	)
	branchApproved, _ := firstBool(
		boolCandidate(lookupBool(contractPayload, "branch_policy.approved")),
		boolCandidate(lookupBool(contractPayload, "branch_policy.target_approved")),
		boolCandidate(lookupBool(contractPayload, "branch.approved")),
	)
	requireApprovedTarget, _ := firstBool(
		boolCandidate(lookupBool(contractPayload, "branch_policy.require_approved_target")),
		boolCandidate(lookupBool(contractPayload, "branch.require_approved_target")),
	)

	approvalAt := firstTime(
		lookupTime(contractPayload, "approval.approved_at"),
		lookupTime(contractPayload, "approval.approvedAt"),
	)
	expiresAt := firstTime(
		lookupTime(contractPayload, "expires_at"),
		lookupTime(contractPayload, "expiresAt"),
	)

	contract := execresult.ExecutionContract{
		ID:            firstString(lookupString(contractPayload, "id"), lookupString(contractPayload, "contract_id"), lookupString(contractPayload, "contractId")),
		TaskID:        firstString(lookupString(contractPayload, "task_id"), lookupString(contractPayload, "taskId"), taskID),
		ExecutionMode: execresult.ExecutionMode(firstString(lookupString(contractPayload, "execution_mode"), lookupString(contractPayload, "executionMode"), lookupString(contractPayload, "mode"))),
		AllowedActions: firstSlice(
			lookupStrings(contractPayload, "allowed_actions"),
			lookupStrings(contractPayload, "allowedActions"),
			lookupStrings(contractPayload, "actions"),
		),
		Retry: execresult.RetryAllowance{
			Allowed:  retryAllowed,
			MaxRetry: maxInt(0, lookupInt(contractPayload, "retry.max_retry"), lookupInt(contractPayload, "retry.maxRetry"), lookupInt(contractPayload, "max_retry"), lookupInt(contractPayload, "maxRetry")),
		},
		Branch: execresult.BranchPolicy{
			BaseBranch: firstString(
				lookupString(contractPayload, "branch_policy.base_branch"),
				lookupString(contractPayload, "branch_policy.baseBranch"),
				lookupString(contractPayload, "branch.base_branch"),
			),
			TargetBranch: firstString(
				lookupString(contractPayload, "branch_policy.target_branch"),
				lookupString(contractPayload, "branch_policy.targetBranch"),
				lookupString(contractPayload, "branch.target_branch"),
				lookupString(contractPayload, "branch_name"),
				lookupString(contractPayload, "branchName"),
			),
			ApprovedTargetBranch: firstString(
				lookupString(contractPayload, "branch_policy.approved_target_branch"),
				lookupString(contractPayload, "branch_policy.approvedTargetBranch"),
				lookupString(contractPayload, "branch.approved_target_branch"),
				lookupString(contractPayload, "approved_branch_target"),
			),
			AllowedTargetBranches: firstSlice(
				lookupStrings(contractPayload, "branch_policy.allowed_target_branches"),
				lookupStrings(contractPayload, "branch_policy.allowedTargetBranches"),
				lookupStrings(contractPayload, "branch.allowed_target_branches"),
				lookupStrings(contractPayload, "allowed_branches"),
			),
			RequireApprovedTarget: requireApprovedTarget,
			Approved:              branchApproved,
		},
		Write: execresult.WritePermissions{
			AllowWrite:        writeAllowed,
			ReadOnly:          readOnly,
			DryRun:            dryRun,
			WorkspaceOnly:     !foundWorkspaceOnly || workspaceOnly,
			NoAutonomousWrite: noAutonomousWrite,
			AllowedPaths: firstSlice(
				lookupStrings(contractPayload, "write_permissions.allowed_paths"),
				lookupStrings(contractPayload, "write_permissions.allowedPaths"),
				lookupStrings(contractPayload, "write.allowed_paths"),
				lookupStrings(contractPayload, "allowed_paths"),
			),
		},
		Approval: execresult.ApprovalState{
			Required:   required,
			Approved:   approved,
			Reference:  firstString(lookupString(contractPayload, "approval.reference"), lookupString(contractPayload, "approval.approval_reference"), lookupString(contractPayload, "approval_reference")),
			ApprovedBy: firstString(lookupString(contractPayload, "approval.approved_by"), lookupString(contractPayload, "approval.approvedBy")),
			ApprovedAt: approvalAt,
		},
		ExpiresAt:            expiresAt,
		PolicyVersion:        firstString(lookupString(contractPayload, "policy_version"), lookupString(contractPayload, "policyVersion")),
		AutonomyReasoningRef: firstString(lookupString(contractPayload, "autonomy_reasoning_ref"), lookupString(contractPayload, "autonomyReasoningRef"), lookupString(contractPayload, "reasoning_reference")),
	}

	if contract.Branch.ApprovedTargetBranch != "" && contract.Branch.TargetBranch != "" && contract.Branch.TargetBranch == contract.Branch.ApprovedTargetBranch {
		contract.Branch.Approved = true
	}

	return contract
}

func parsePolicySnapshot(payload map[string]any, fallbackVersion string) execresult.PolicySnapshot {
	policyPayload := firstMap(
		lookupMap(payload, "policy_snapshot"),
		lookupMap(payload, "policySnapshot"),
		lookupMap(payload, "policy_decision"),
		lookupMap(payload, "policyDecision"),
		lookupMap(payload, "autonomy.policy_decision"),
		lookupMap(payload, "autonomy.policyDecision"),
	)
	if policyPayload == nil {
		return execresult.PolicySnapshot{}
	}

	approvalRequired, _ := firstBool(
		boolCandidate(lookupBool(policyPayload, "approval_required")),
		boolCandidate(lookupBool(policyPayload, "require_approval")),
	)
	reviewRequired, _ := firstBool(
		boolCandidate(lookupBool(policyPayload, "review_required")),
		boolCandidate(lookupBool(policyPayload, "require_review")),
	)
	retryAllowed, _ := firstBool(
		boolCandidate(lookupBool(policyPayload, "retry_allowed")),
	)
	blocked, _ := firstBool(
		boolCandidate(lookupBool(policyPayload, "block")),
	)
	escalate, _ := firstBool(
		boolCandidate(lookupBool(policyPayload, "escalate")),
	)

	forbiddenActions := firstSlice(
		lookupStrings(policyPayload, "forbidden_actions"),
		lookupStrings(policyPayload, "evidence.forbidden_actions"),
	)

	return execresult.PolicySnapshot{
		Version:            firstString(lookupString(policyPayload, "version"), lookupString(policyPayload, "policy_version"), fallbackVersion),
		DecisionSource:     firstString(lookupString(policyPayload, "decision_source"), lookupString(payload, "policy_source")),
		AutonomyMode:       firstString(lookupString(policyPayload, "autonomy_mode")),
		ApprovalRequired:   approvalRequired,
		ReviewRequired:     reviewRequired,
		RetryAllowed:       retryAllowed,
		MaxRetry:           maxInt(0, lookupInt(policyPayload, "max_retry"), lookupInt(policyPayload, "maxRetry")),
		Block:              blocked,
		Escalate:           escalate,
		FinalAction:        firstString(lookupString(policyPayload, "final_action"), lookupString(policyPayload, "finalAction")),
		AllowedActions:     firstSlice(lookupStrings(policyPayload, "allowed_actions"), lookupStrings(policyPayload, "allowedActions")),
		ReasonCodes:        firstSlice(lookupStrings(policyPayload, "reason_codes"), lookupStrings(policyPayload, "reasonCodes")),
		TaskClassification: firstString(lookupString(policyPayload, "task_classification"), lookupString(policyPayload, "taskClassification")),
		TaskRiskLevel:      firstString(lookupString(policyPayload, "task_risk_level"), lookupString(policyPayload, "taskRiskLevel")),
		SensitiveScope:     firstSlice(lookupStrings(policyPayload, "sensitive_scope"), lookupStrings(policyPayload, "sensitiveScope")),
		SensitivePaths:     firstSlice(lookupStrings(policyPayload, "sensitive_paths"), lookupStrings(policyPayload, "sensitivePaths")),
		ForbiddenActions:   forbiddenActions,
		Evidence:           lookupMap(policyPayload, "evidence"),
	}
}

func firstMap(candidates ...map[string]any) map[string]any {
	for _, candidate := range candidates {
		if len(candidate) > 0 {
			return candidate
		}
	}
	return nil
}

func firstTime(values ...*time.Time) *time.Time {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}
