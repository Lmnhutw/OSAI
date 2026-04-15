package worker

import (
	"fmt"
	"strings"
	"time"

	execresult "execution-go/internal/result"
)

type executionPlan struct {
	Mode                 execresult.ExecutionMode
	RunCodex             bool
	RunValidation        bool
	WriteEnabled         bool
	InspectOnly          bool
	DryRun               bool
	ReadOnly             bool
	EffectiveMaxAttempts int
}

type contractDecision struct {
	Plan                  executionPlan
	SafetyChecks          []execresult.SafetyCheck
	FailureClassification execresult.FailureClassification
	FailureReason         string
}

func validateExecutionContract(spec ExecutionSpec, maxAttempts int) contractDecision {
	now := time.Now().UTC()
	contract := spec.Contract
	policy := spec.PolicySnapshot
	policyPresent := policySnapshotPresent(policy)

	checks := make([]execresult.SafetyCheck, 0, 12)
	fail := func(name string, classification execresult.FailureClassification, detail string) contractDecision {
		checks = append(checks, failedCheck(name, detail))
		return contractDecision{
			SafetyChecks:          checks,
			FailureClassification: classification,
			FailureReason:         detail,
		}
	}
	pass := func(name, detail string) {
		checks = append(checks, passedCheck(name, detail))
	}

	if strings.TrimSpace(contract.ID) == "" {
		return fail("execution_contract_present", execresult.FailureClassificationPolicyRejected, "Execution contract is required before the worker can run this task.")
	}
	pass("execution_contract_present", "Execution contract was supplied by the control plane.")

	if strings.TrimSpace(contract.TaskID) != "" && contract.TaskID != spec.TaskID {
		return fail("execution_contract_task_match", execresult.FailureClassificationPolicyRejected, fmt.Sprintf("Execution contract task_id %q does not match claimed task %q.", contract.TaskID, spec.TaskID))
	}
	pass("execution_contract_task_match", "Execution contract task id matches the claimed task.")

	mode, ok := normalizeExecutionMode(contract.ExecutionMode)
	if !ok {
		return fail("execution_mode_supported", execresult.FailureClassificationPolicyRejected, fmt.Sprintf("Execution contract mode %q is not supported.", contract.ExecutionMode))
	}
	pass("execution_mode_supported", "Execution contract mode is recognized by the worker.")

	if contract.ExpiresAt != nil && now.After(contract.ExpiresAt.UTC()) {
		return fail("execution_contract_not_expired", execresult.FailureClassificationPolicyRejected, fmt.Sprintf("Execution contract expired at %s.", contract.ExpiresAt.UTC().Format(time.RFC3339)))
	}
	pass("execution_contract_not_expired", "Execution contract is still valid.")

	if policyPresent && (policy.Block || strings.EqualFold(policy.AutonomyMode, string(execresult.ExecutionModeBlocked))) || mode == execresult.ExecutionModeBlocked {
		return fail("policy_allows_execution", execresult.FailureClassificationPolicyRejected, "The control plane marked this execution as blocked.")
	}
	if policyPresent && (policy.ReviewRequired || strings.EqualFold(policy.AutonomyMode, "review_required")) {
		return fail("policy_allows_execution", execresult.FailureClassificationPolicyRejected, "The control plane requires review before this worker may execute the task.")
	}
	if policyPresent && len(policy.AllowedActions) > 0 && !containsStringFold(policy.AllowedActions, "dispatch_execution") {
		return fail("policy_allows_execution", execresult.FailureClassificationPolicyRejected, "The control plane policy did not authorize dispatch_execution for this task.")
	}
	pass("policy_allows_execution", "The control plane policy allows execution dispatch.")

	if policyPresent && len(policy.ForbiddenActions) > 0 {
		return fail("sensitive_scope_restrictions", execresult.FailureClassificationSensitiveScopeBlocked, "Sensitive scope restrictions blocked one or more execution actions: "+strings.Join(policy.ForbiddenActions, ", "))
	}
	pass("sensitive_scope_restrictions", "No sensitive-scope forbidden actions were attached to the policy snapshot.")

	if policyPresent && policy.ApprovalRequired && !contract.Approval.Required {
		return fail("approval_state_captured", execresult.FailureClassificationPolicyRejected, "The policy snapshot requires approval, but the execution contract does not record approval_required.")
	}
	if policyPresent && policy.RetryAllowed == false && contract.Retry.Allowed {
		return fail("retry_policy_consistent", execresult.FailureClassificationPolicyRejected, "The execution contract allows retries, but the policy snapshot forbids them.")
	}
	if policyPresent && policy.MaxRetry > 0 && contract.Retry.Allowed && contract.Retry.MaxRetry > policy.MaxRetry {
		return fail("retry_policy_consistent", execresult.FailureClassificationPolicyRejected, fmt.Sprintf("The execution contract max_retry=%d exceeds the policy snapshot max_retry=%d.", contract.Retry.MaxRetry, policy.MaxRetry))
	}
	pass("retry_policy_consistent", "Execution contract retry policy does not exceed the control plane policy snapshot.")

	approvalRequired := contract.Approval.Required || (policyPresent && policy.ApprovalRequired)
	if approvalRequired && !contract.Approval.Approved {
		return fail("approval_state_satisfied", execresult.FailureClassificationApprovalMissing, "Human approval is required by the execution contract, but approval is missing.")
	}
	if approvalRequired {
		pass("approval_state_satisfied", "Required human approval is present in the execution contract.")
	} else {
		pass("approval_state_satisfied", "Execution contract does not require human approval for this run.")
	}

	plan := buildExecutionPlan(mode, contract.Retry, maxAttempts, contract.Write.DryRun, contract.Write.ReadOnly)

	if !contract.Write.WorkspaceOnly {
		return fail("workspace_write_boundary", execresult.FailureClassificationPolicyRejected, "Execution contract attempted to allow writes outside the workspace boundary.")
	}
	pass("workspace_write_boundary", "Execution contract keeps writes constrained to the workspace.")

	if spec.RetryCount > 0 && !contract.Retry.Allowed {
		return fail("retry_limit", execresult.FailureClassificationRetryLimitExceeded, fmt.Sprintf("Retry count %d exceeds the contract allowance of zero retries.", spec.RetryCount))
	}
	if contract.Retry.Allowed && spec.RetryCount > contract.Retry.MaxRetry {
		return fail("retry_limit", execresult.FailureClassificationRetryLimitExceeded, fmt.Sprintf("Retry count %d exceeds the contract max_retry=%d.", spec.RetryCount, contract.Retry.MaxRetry))
	}
	pass("retry_limit", "Current retry count is within the execution contract allowance.")

	requiredActions := requiredActionsForPlan(plan)
	for _, action := range requiredActions {
		if !containsStringFold(contract.AllowedActions, action) {
			return fail("allowed_actions", execresult.FailureClassificationAutonomyForbidden, fmt.Sprintf("Execution contract does not allow the worker action %q.", action))
		}
	}
	pass("allowed_actions", "Execution contract includes every worker action required by the selected execution mode.")

	if plan.WriteEnabled {
		if contract.Write.NoAutonomousWrite {
			return fail("write_authorization", execresult.FailureClassificationAutonomyForbidden, "Execution contract explicitly forbids autonomous writes.")
		}
		if contract.Write.ReadOnly {
			return fail("write_authorization", execresult.FailureClassificationAutonomyForbidden, "Execution contract is read-only and cannot be used for a write-capable execution mode.")
		}
		if !contract.Write.AllowWrite {
			return fail("write_authorization", execresult.FailureClassificationAutonomyForbidden, "Execution contract did not grant workspace write permission.")
		}
		if strings.TrimSpace(contract.Branch.TargetBranch) == "" {
			return fail("approved_branch_target", execresult.FailureClassificationPolicyRejected, "Execution contract did not provide an approved branch target for write execution.")
		}
		if contract.Branch.RequireApprovedTarget && !contract.Branch.Approved {
			return fail("approved_branch_target", execresult.FailureClassificationPolicyRejected, "Execution contract requires an approved branch target, but the target is not marked approved.")
		}
		if strings.TrimSpace(contract.Branch.ApprovedTargetBranch) != "" && contract.Branch.TargetBranch != contract.Branch.ApprovedTargetBranch {
			return fail("approved_branch_target", execresult.FailureClassificationPolicyRejected, fmt.Sprintf("Execution contract target branch %q does not match the approved branch %q.", contract.Branch.TargetBranch, contract.Branch.ApprovedTargetBranch))
		}
		if len(contract.Branch.AllowedTargetBranches) > 0 && !containsString(contract.Branch.AllowedTargetBranches, contract.Branch.TargetBranch) {
			return fail("approved_branch_target", execresult.FailureClassificationPolicyRejected, fmt.Sprintf("Execution contract target branch %q is outside the allowed branch policy.", contract.Branch.TargetBranch))
		}
		pass("approved_branch_target", "Execution contract branch target is approved for write execution.")
	} else {
		pass("approved_branch_target", "Write branch approval is not required for this execution mode.")
	}

	return contractDecision{
		Plan:         plan,
		SafetyChecks: checks,
	}
}

func policySnapshotPresent(policy execresult.PolicySnapshot) bool {
	return strings.TrimSpace(policy.Version) != "" ||
		strings.TrimSpace(policy.AutonomyMode) != "" ||
		strings.TrimSpace(policy.FinalAction) != "" ||
		len(policy.AllowedActions) > 0 ||
		len(policy.ReasonCodes) > 0 ||
		len(policy.SensitiveScope) > 0 ||
		len(policy.ForbiddenActions) > 0 ||
		len(policy.Evidence) > 0 ||
		policy.ApprovalRequired ||
		policy.ReviewRequired ||
		policy.RetryAllowed ||
		policy.Block ||
		policy.Escalate ||
		policy.MaxRetry > 0
}

func buildExecutionPlan(
	mode execresult.ExecutionMode,
	retry execresult.RetryAllowance,
	maxAttempts int,
	dryRun bool,
	readOnly bool,
) executionPlan {
	plan := executionPlan{
		Mode:                 mode,
		DryRun:               dryRun,
		ReadOnly:             readOnly || mode == execresult.ExecutionModeInspectOnly,
		EffectiveMaxAttempts: max(1, maxAttempts),
	}

	switch mode {
	case execresult.ExecutionModeInspectOnly:
		plan.InspectOnly = true
	case execresult.ExecutionModeDraftChanges, execresult.ExecutionModeExecuteWithWrite:
		plan.RunCodex = !dryRun
		plan.WriteEnabled = !dryRun
	case execresult.ExecutionModeExecuteWithValidation:
		plan.RunCodex = !dryRun
		plan.RunValidation = !dryRun
		plan.WriteEnabled = !dryRun
	}

	if !retry.Allowed {
		plan.EffectiveMaxAttempts = 1
		return plan
	}

	allowedAttempts := retry.MaxRetry + 1
	if retry.MaxRetry <= 0 {
		allowedAttempts = 1
	}
	if allowedAttempts < plan.EffectiveMaxAttempts {
		plan.EffectiveMaxAttempts = allowedAttempts
	}
	return plan
}

func normalizeExecutionMode(mode execresult.ExecutionMode) (execresult.ExecutionMode, bool) {
	switch strings.TrimSpace(string(mode)) {
	case string(execresult.ExecutionModeInspectOnly):
		return execresult.ExecutionModeInspectOnly, true
	case string(execresult.ExecutionModeDraftChanges):
		return execresult.ExecutionModeDraftChanges, true
	case string(execresult.ExecutionModeExecuteWithWrite):
		return execresult.ExecutionModeExecuteWithWrite, true
	case string(execresult.ExecutionModeExecuteWithValidation):
		return execresult.ExecutionModeExecuteWithValidation, true
	case string(execresult.ExecutionModeBlocked):
		return execresult.ExecutionModeBlocked, true
	default:
		return "", false
	}
}

func requiredActionsForPlan(plan executionPlan) []string {
	actions := []string{"prepare_workspace"}
	if plan.InspectOnly || plan.ReadOnly {
		actions = append(actions, "inspect_workspace")
	}
	if plan.RunCodex {
		actions = append(actions, "run_codex")
	}
	if plan.WriteEnabled {
		actions = append(actions, "write_workspace")
	}
	if plan.RunValidation {
		actions = append(actions, "run_validation")
	}
	return actions
}

func passedCheck(name, detail string) execresult.SafetyCheck {
	return execresult.SafetyCheck{Name: name, Status: "passed", Detail: detail}
}

func failedCheck(name, detail string) execresult.SafetyCheck {
	return execresult.SafetyCheck{Name: name, Status: "failed", Detail: detail}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if strings.TrimSpace(value) == strings.TrimSpace(target) {
			return true
		}
	}
	return false
}

func containsStringFold(values []string, target string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), strings.TrimSpace(target)) {
			return true
		}
	}
	return false
}
