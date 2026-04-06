from datetime import datetime, timezone
from typing import List, Sequence

from ..models import TaskLoop
from ..schemas import (
    BugTriageRead,
    FailurePatternRead,
    PolicyDecisionRead,
    QADecisionRead,
    ResultEvaluationRead,
    ReviewerDecisionRead,
)
from .control_plane_support import HIGH_RISK_TASK_TYPES, TaskContext, RunContext, previous_failure_count

DEFAULT_MAX_RETRY = 2
DEFAULT_MAX_CHAIN_DEPTH = 4
DEFAULT_LOOP_TIMEOUT_SECONDS = 7200
DEFAULT_RISK_THRESHOLD = "high"


def _loop_policy_defaults(task_type: str) -> dict:
    if task_type in HIGH_RISK_TASK_TYPES:
        return {
            "max_retry": 1,
            "max_chain_depth": 2,
            "loop_timeout_seconds": 3600,
            "risk_threshold": "medium",
        }
    return {
        "max_retry": DEFAULT_MAX_RETRY,
        "max_chain_depth": DEFAULT_MAX_CHAIN_DEPTH,
        "loop_timeout_seconds": DEFAULT_LOOP_TIMEOUT_SECONDS,
        "risk_threshold": DEFAULT_RISK_THRESHOLD,
    }


def evaluate_dispatch_policy(
    task_context: TaskContext,
    *,
    risk_flags: Sequence[str],
    missing_context: Sequence[str],
) -> PolicyDecisionRead:
    reason_codes: List[str] = []
    lowered_flags = set(risk_flags)
    failures = previous_failure_count(task_context.execution_runs)
    defaults = _loop_policy_defaults(task_context.task.task_type)

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
        manual_break_required=block or escalate,
        max_retry=defaults["max_retry"],
        max_chain_depth=defaults["max_chain_depth"],
        loop_timeout_seconds=defaults["loop_timeout_seconds"],
        risk_threshold=defaults["risk_threshold"],
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
    defaults = _loop_policy_defaults(run_context.task_context.task.task_type)

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
        manual_break_required=block or escalate,
        max_retry=defaults["max_retry"],
        max_chain_depth=defaults["max_chain_depth"],
        loop_timeout_seconds=defaults["loop_timeout_seconds"],
        risk_threshold=defaults["risk_threshold"],
        reason_codes=list(dict.fromkeys(reason_codes)),
        evidence={
            "previous_failures": failures,
            "run_status": run_context.execution_run.status,
            "task_status": run_context.task_context.task.status,
        },
    )


def evaluate_loop_policy(
    task_context: TaskContext,
    *,
    loop_state: TaskLoop,
    result_evaluation: ResultEvaluationRead,
    bug_triage: BugTriageRead,
    failure_patterns: Sequence[FailurePatternRead],
) -> PolicyDecisionRead:
    defaults = _loop_policy_defaults(task_context.task.task_type)
    recurring_patterns = [pattern for pattern in failure_patterns if pattern.recurring]
    retry_budget_exceeded = loop_state.retry_count >= defaults["max_retry"]
    chain_depth_exceeded = loop_state.chain_depth >= defaults["max_chain_depth"]
    loop_timeout_exceeded = bool(loop_state.timeout_at and datetime.now(timezone.utc) >= loop_state.timeout_at)

    reason_codes: List[str] = []
    if retry_budget_exceeded:
        reason_codes.append("retry_budget_exceeded")
    if chain_depth_exceeded:
        reason_codes.append("chain_depth_exceeded")
    if loop_timeout_exceeded:
        reason_codes.append("loop_timeout_exceeded")
    if recurring_patterns:
        reason_codes.append("recurring_failure_pattern")

    require_review = result_evaluation.status == "awaiting_review" or bug_triage.category == "spec_issue"
    if require_review:
        reason_codes.append("review_required")

    require_qa = result_evaluation.status == "qa_pending" or bug_triage.category == "test_issue"
    if require_qa:
        reason_codes.append("qa_required")

    require_approval = task_context.plan.status != "approved" or bug_triage.category == "spec_issue"
    if require_approval:
        reason_codes.append("approval_required")

    block = result_evaluation.status == "blocked"
    if block:
        reason_codes.append("result_blocked")

    escalate = any(
        (
            retry_budget_exceeded,
            chain_depth_exceeded,
            loop_timeout_exceeded,
            bug_triage.recommended_action == "escalate",
            bool(recurring_patterns and loop_state.retry_count >= 1),
        )
    )
    if escalate:
        reason_codes.append("escalate")

    manual_break_required = any(
        (
            require_approval,
            loop_timeout_exceeded,
            retry_budget_exceeded,
            chain_depth_exceeded,
            bug_triage.category == "spec_issue",
        )
    )
    if manual_break_required:
        reason_codes.append("manual_break_required")

    retry_allowed = (
        bug_triage.recommended_action == "retry"
        and not any((retry_budget_exceeded, chain_depth_exceeded, loop_timeout_exceeded, recurring_patterns))
    )
    if retry_allowed:
        reason_codes.append("retry_allowed")

    allow_auto_execute = not any(
        (
            block,
            require_review,
            require_qa,
            require_approval,
            manual_break_required,
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
        manual_break_required=manual_break_required,
        max_retry=defaults["max_retry"],
        max_chain_depth=defaults["max_chain_depth"],
        loop_timeout_seconds=defaults["loop_timeout_seconds"],
        risk_threshold=defaults["risk_threshold"],
        reason_codes=list(dict.fromkeys(reason_codes)),
        evidence={
            "retry_count": loop_state.retry_count,
            "chain_depth": loop_state.chain_depth,
            "result_status": result_evaluation.status,
            "bug_category": bug_triage.category,
            "recurring_patterns": [pattern.pattern_key for pattern in recurring_patterns],
        },
    )
