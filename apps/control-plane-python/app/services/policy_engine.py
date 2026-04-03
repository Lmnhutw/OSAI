from typing import List, Sequence

from ..schemas import PolicyDecisionRead, QADecisionRead, ReviewerDecisionRead
from .control_plane_support import HIGH_RISK_TASK_TYPES, TaskContext, RunContext, previous_failure_count


def evaluate_dispatch_policy(
    task_context: TaskContext,
    *,
    risk_flags: Sequence[str],
    missing_context: Sequence[str],
) -> PolicyDecisionRead:
    reason_codes: List[str] = []
    lowered_flags = set(risk_flags)
    failures = previous_failure_count(task_context.execution_runs)

    require_approval = task_context.plan.status != "approved" or task_context.task.status == "pending"
    if require_approval:
        reason_codes.append("approval_required")

    require_review = bool(
        lowered_flags.intersection(
            {
                "high_risk_task_type",
                "risky_change_surface",
                "repeated_failure_pattern",
                "protected_scope_change",
            }
        )
    )
    if task_context.task.task_type in HIGH_RISK_TASK_TYPES:
        require_review = True
    if require_review:
        reason_codes.append("review_required")

    require_qa = task_context.task.task_type == "verification" or "risky_change_surface" in lowered_flags
    if require_qa:
        reason_codes.append("qa_required")

    block = bool(
        lowered_flags.intersection({"blocked_dependency", "protected_scope_change"})
    )
    if block:
        reason_codes.append("dispatch_blocked")

    escalate = failures >= 3
    if escalate:
        reason_codes.append("retry_budget_exceeded")

    if missing_context:
        reason_codes.append("missing_context")

    allow_auto_execute = not any(
        (
            missing_context,
            block,
            require_approval,
            require_review,
            require_qa,
            escalate,
        )
    )

    retry_allowed = failures < 2 and not block and not escalate

    return PolicyDecisionRead(
        allow_auto_execute=allow_auto_execute,
        require_review=require_review,
        require_qa=require_qa,
        require_approval=require_approval,
        block=block,
        escalate=escalate,
        retry_allowed=retry_allowed,
        reason_codes=list(dict.fromkeys(reason_codes)),
        evidence={
            "previous_failures": failures,
            "task_status": task_context.task.status,
            "plan_status": task_context.plan.status,
        },
    )


def evaluate_result_policy(
    run_context: RunContext,
    *,
    risk_flags: Sequence[str],
    result_status: str,
    reviewer_decision: ReviewerDecisionRead,
    qa_decision: QADecisionRead,
) -> PolicyDecisionRead:
    reason_codes: List[str] = []
    lowered_flags = set(risk_flags)
    failures = previous_failure_count(run_context.task_context.execution_runs)

    require_review = reviewer_decision.scope_deviation or bool(reviewer_decision.risky_changes)
    if require_review:
        reason_codes.append("review_required")

    require_qa = bool(qa_decision.missing_checks or qa_decision.potential_regressions) or result_status == "qa_pending"
    if require_qa:
        reason_codes.append("qa_required")

    require_approval = "protected_scope_change" in lowered_flags or "approval_required" in lowered_flags
    if require_approval:
        reason_codes.append("approval_required")

    block = result_status == "blocked"
    if block:
        reason_codes.append("result_blocked")

    escalate = failures >= 3 or reviewer_decision.scope_deviation
    if escalate:
        reason_codes.append("escalate")

    retry_allowed = result_status in {"needs_rework", "blocked"} and failures < 2 and not escalate
    if result_status == "needs_rework":
        reason_codes.append("rework_required")

    allow_auto_execute = not any(
        (
            block,
            require_review,
            require_qa,
            require_approval,
            escalate,
        )
    )

    return PolicyDecisionRead(
        allow_auto_execute=allow_auto_execute,
        require_review=require_review,
        require_qa=require_qa,
        require_approval=require_approval,
        block=block,
        escalate=escalate,
        retry_allowed=retry_allowed,
        reason_codes=list(dict.fromkeys(reason_codes)),
        evidence={
            "previous_failures": failures,
            "run_status": run_context.execution_run.status,
            "task_status": run_context.task_context.task.status,
        },
    )
