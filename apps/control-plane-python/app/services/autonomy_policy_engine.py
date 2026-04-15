from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import or_
from sqlmodel import Session, select

from ..models import AutonomyOverride
from ..schemas import (
    BugTriageRead,
    FailurePatternRead,
    PolicyDecisionRead,
    QADecisionRead,
    ResultEvaluationRead,
    ReviewerDecisionRead,
)
from .confidence_scoring import (
    score_dispatch_readiness,
    score_execution_safety,
    score_post_result_confidence,
    score_retry_viability,
)
from .control_plane_support import (
    TaskContext,
    RunContext,
    extract_changed_files,
    get_run_context,
    get_task_loop,
    previous_failure_count,
    unique_list,
)
from .sensitive_scope import detect_sensitive_scope
from .task_classification import classify_task

DEFAULT_MAX_RETRY = 2
DEFAULT_MAX_CHAIN_DEPTH = 4
DEFAULT_LOOP_TIMEOUT_SECONDS = 7200
DEFAULT_RISK_THRESHOLD = "medium"

MODE_ORDER = {
    "auto_execute": 0,
    "review_required": 1,
    "approval_required": 2,
    "blocked": 3,
}
AUTO_EXECUTE_CLASSES = {"test_only", "low_risk_implementation"}
REVIEW_CLASSES = {"bugfix", "refactor", "medium_risk_implementation"}
APPROVAL_CLASSES = {
    "high_risk_implementation",
    "architecture_sensitive",
    "infra_sensitive",
    "schema_sensitive",
}
HIGH_SENSITIVITY_DOMAINS = {
    "authentication",
    "billing_payments",
    "security_critical",
    "schema_migration",
    "deployment_config",
    "shared_core_library",
}
SUPPORTED_OVERRIDE_MODES = set(MODE_ORDER)


@dataclass
class ResolvedOverrides:
    records: List[AutonomyOverride] = field(default_factory=list)
    force_mode: Optional[str] = None
    force_review: bool = False
    disable_retries: bool = False
    sensitive_modules: List[str] = field(default_factory=list)
    policy_adjustments: Dict[str, Any] = field(default_factory=dict)
    summary: Optional[str] = None

    @property
    def applied(self) -> bool:
        return bool(self.records)


def _promote_mode(current: str, desired: str) -> str:
    return desired if MODE_ORDER[desired] > MODE_ORDER[current] else current


def _thresholds(overrides: ResolvedOverrides) -> Dict[str, float]:
    return {
        "auto_execute_min_confidence": float(
            overrides.policy_adjustments.get("auto_execute_min_confidence", 0.78)
        ),
        "review_min_confidence": float(
            overrides.policy_adjustments.get("review_min_confidence", 0.58)
        ),
        "block_below_confidence": float(
            overrides.policy_adjustments.get("block_below_confidence", 0.35)
        ),
    }


def _loop_policy_defaults(task_type: str, classification_category: str, overrides: ResolvedOverrides) -> dict:
    high_risk = task_type in {"verification", "migration", "database", "infra", "security", "deployment"} or classification_category in APPROVAL_CLASSES
    defaults = {
        "max_retry": 1 if high_risk else DEFAULT_MAX_RETRY,
        "max_chain_depth": 2 if high_risk else DEFAULT_MAX_CHAIN_DEPTH,
        "loop_timeout_seconds": 3600 if high_risk else DEFAULT_LOOP_TIMEOUT_SECONDS,
        "risk_threshold": "high" if high_risk else DEFAULT_RISK_THRESHOLD,
    }
    defaults.update(
        {
            key: overrides.policy_adjustments[key]
            for key in ("max_retry", "max_chain_depth", "loop_timeout_seconds", "risk_threshold")
            if key in overrides.policy_adjustments
        }
    )
    return defaults


def resolve_overrides(session: Session, *, project_id, task_id) -> ResolvedOverrides:
    rows = session.exec(
        select(AutonomyOverride)
        .where(
            AutonomyOverride.status == "active",
            or_(
                AutonomyOverride.project_id == project_id,
                AutonomyOverride.task_id == task_id,
            ),
        )
        .order_by(AutonomyOverride.created_at.asc())
    ).all()
    resolved = ResolvedOverrides(records=rows)
    summary_parts: List[str] = []
    for row in rows:
        if row.force_autonomy_mode in SUPPORTED_OVERRIDE_MODES:
            resolved.force_mode = row.force_autonomy_mode
        resolved.force_review = resolved.force_review or row.force_review
        resolved.disable_retries = resolved.disable_retries or row.disable_retries
        resolved.sensitive_modules = unique_list([*resolved.sensitive_modules, *(row.sensitive_modules or [])])
        resolved.policy_adjustments.update(row.policy_adjustments or {})
        scope_label = f"{row.scope}:{row.operator}"
        details: List[str] = []
        if row.force_autonomy_mode:
            details.append(f"force_mode={row.force_autonomy_mode}")
        if row.force_review:
            details.append("force_review")
        if row.disable_retries:
            details.append("disable_retries")
        if row.sensitive_modules:
            details.append(f"sensitive_modules={len(row.sensitive_modules)}")
        summary_parts.append(scope_label + (f" ({', '.join(details)})" if details else ""))
    resolved.summary = "; ".join(summary_parts) if summary_parts else None
    return resolved


def _previous_auto_safe(task_context: TaskContext) -> bool:
    for event in task_context.events:
        if event.event_type not in {
            "policy.dispatch_decision",
            "policy.result_decision",
            "autonomy.decision_recorded",
        }:
            continue
        payload = event.payload or {}
        decision = payload.get("decision") if isinstance(payload.get("decision"), dict) else payload.get("policy_decision")
        if isinstance(decision, dict) and decision.get("allow_auto_execute"):
            return True
    return False


def _base_reason_codes(
    *,
    classification,
    sensitive_scope,
    extra_codes: Optional[Sequence[str]] = None,
) -> List[str]:
    reason_codes = [classification.category, *classification.reasons]
    reason_codes.extend(f"sensitive_{domain}" for domain in sensitive_scope.domains)
    reason_codes.extend(extra_codes or [])
    return unique_list(reason_codes)


def _finalize_decision(
    *,
    stage: str,
    classification,
    sensitive_scope,
    overrides: ResolvedOverrides,
    defaults: Dict[str, Any],
    reason_codes: Sequence[str],
    evidence: Dict[str, Any],
    contributing_factors: Dict[str, Any],
    require_review: bool,
    require_qa: bool,
    require_approval: bool,
    block: bool,
    escalate: bool,
    retry_allowed: bool,
    escalation_reason: Optional[str],
    suggested_action: str,
    confidence_score: float,
) -> PolicyDecisionRead:
    autonomy_mode = "auto_execute"
    if block:
        autonomy_mode = "blocked"
    elif require_approval:
        autonomy_mode = "approval_required"
    elif require_review or require_qa or escalate:
        autonomy_mode = "review_required"

    if overrides.force_mode and not (block and overrides.force_mode != "blocked"):
        autonomy_mode = overrides.force_mode
        if overrides.force_mode == "auto_execute":
            require_review = False
            require_qa = False
            require_approval = False
            block = False
            escalate = False
        elif overrides.force_mode == "review_required":
            require_review = True
            require_approval = False
            block = False
        elif overrides.force_mode == "approval_required":
            require_approval = True
            require_review = True
            block = False
        elif overrides.force_mode == "blocked":
            block = True
            require_review = False
            require_approval = False

    if overrides.force_review:
        autonomy_mode = _promote_mode(autonomy_mode, "review_required")
        require_review = True
        if autonomy_mode == "auto_execute":
            autonomy_mode = "review_required"

    if block:
        retry_allowed = False
    if overrides.disable_retries:
        retry_allowed = False

    allowed_actions: List[str]
    final_action = suggested_action
    if stage == "dispatch":
        if autonomy_mode == "auto_execute":
            allowed_actions = ["dispatch_execution"]
            final_action = "dispatch_execution"
        elif autonomy_mode == "review_required":
            allowed_actions = ["request_review", "request_override"]
            final_action = "request_review"
        elif autonomy_mode == "approval_required":
            allowed_actions = ["request_human_approval", "request_override"]
            final_action = "request_human_approval"
        else:
            allowed_actions = ["block_dispatch", "escalate_to_human"]
            final_action = "block_dispatch"
    elif stage == "result":
        if autonomy_mode == "blocked":
            allowed_actions = ["halt_task", "escalate_to_human"]
            final_action = "halt_task"
        elif autonomy_mode == "approval_required":
            allowed_actions = ["request_human_approval", "request_review"]
            final_action = "request_human_approval"
        elif autonomy_mode == "review_required":
            allowed_actions = ["request_review", "queue_for_qa"] if require_qa else ["request_review"]
            final_action = "request_review" if require_review else "queue_for_qa"
        else:
            allowed_actions = ["continue_loop"]
            final_action = "continue_loop"
    else:
        if autonomy_mode == "blocked":
            allowed_actions = ["halt_loop", "escalate_to_human"]
            final_action = "halt_loop"
        elif autonomy_mode == "approval_required":
            allowed_actions = ["request_human_approval", "escalate_to_human"]
            final_action = "request_human_approval"
        elif autonomy_mode == "review_required":
            allowed_actions = ["request_review", "queue_for_qa"] if require_qa else ["request_review"]
            final_action = "request_review" if require_review else "queue_for_qa"
        else:
            allowed_actions = [suggested_action]
            if retry_allowed and suggested_action != "schedule_retry":
                allowed_actions.append("schedule_retry")

    confidence_breakdown = {}
    for assessment_name in ("dispatch_readiness", "execution_safety", "post_result_confidence", "retry_viability"):
        assessment = contributing_factors.get(assessment_name)
        if isinstance(assessment, dict):
            confidence_breakdown[assessment_name] = float(assessment.get("score", 0.0))

    return PolicyDecisionRead(
        allow_auto_execute=autonomy_mode == "auto_execute",
        require_review=require_review,
        require_qa=require_qa,
        require_approval=require_approval,
        block=block,
        escalate=escalate,
        retry_allowed=retry_allowed,
        manual_break_required=autonomy_mode != "auto_execute" or escalate,
        max_retry=int(defaults["max_retry"]),
        max_chain_depth=int(defaults["max_chain_depth"]),
        loop_timeout_seconds=int(defaults["loop_timeout_seconds"]),
        risk_threshold=str(defaults["risk_threshold"]),
        reason_codes=unique_list(reason_codes),
        evidence=evidence,
        autonomy_mode=autonomy_mode,
        approval_required=require_approval,
        review_required=require_review,
        escalation_reason=escalation_reason,
        allowed_actions=unique_list(allowed_actions),
        final_action=final_action,
        confidence_score=round(confidence_score, 2),
        confidence_label="high" if confidence_score >= 0.8 else "medium" if confidence_score >= 0.6 else "low",
        confidence_breakdown=confidence_breakdown,
        contributing_factors=contributing_factors,
        task_classification=classification.category,
        task_risk_level=classification.risk_level,
        classification_reasons=classification.reasons,
        sensitive_scope=sensitive_scope.domains,
        sensitive_paths=sensitive_scope.matched_paths,
        override_applied=overrides.applied,
        override_summary=overrides.summary,
    )


def evaluate_dispatch_policy(
    session: Session,
    task_context: TaskContext,
    *,
    risk_flags: Sequence[str],
    missing_context: Sequence[str],
) -> PolicyDecisionRead:
    overrides = resolve_overrides(session, project_id=task_context.project.id, task_id=task_context.task.id)
    classification = classify_task(task_context)
    sensitive_scope = detect_sensitive_scope(
        task_context,
        extra_sensitive_modules=overrides.sensitive_modules,
    )
    dispatch_readiness = score_dispatch_readiness(
        session,
        task_context,
        classification=classification,
        sensitive_scope=sensitive_scope,
        risk_flags=risk_flags,
        missing_context=missing_context,
    )
    execution_safety = score_execution_safety(
        task_context,
        classification=classification,
        sensitive_scope=sensitive_scope,
    )
    confidence_score = min(dispatch_readiness.score, execution_safety.score)
    thresholds = _thresholds(overrides)
    defaults = _loop_policy_defaults(task_context.task.task_type, classification.category, overrides)

    loop_state = get_task_loop(session, task_context.task.id)
    chain_depth = loop_state.chain_depth if loop_state else 0
    failures = previous_failure_count(task_context.execution_runs)
    previous_auto_safe = _previous_auto_safe(task_context)

    hard_block = bool(sensitive_scope.forbidden_actions) or classification.category == "human_only" or "blocked_dependency" in risk_flags
    require_approval = (
        task_context.plan.status != "approved"
        or classification.category in APPROVAL_CLASSES
        or any(domain in HIGH_SENSITIVITY_DOMAINS for domain in sensitive_scope.domains)
    )
    require_review = (
        classification.category in REVIEW_CLASSES
        or (classification.category == "bugfix" and classification.scope_size != "small")
        or sensitive_scope.is_sensitive
        or failures >= 1
    )
    require_qa = task_context.task.task_type == "verification"
    escalate = failures >= 3 or chain_depth >= defaults["max_chain_depth"]
    block = hard_block or len(missing_context) >= 3 or confidence_score < thresholds["block_below_confidence"]

    if confidence_score < thresholds["review_min_confidence"]:
        require_approval = True
    elif confidence_score < thresholds["auto_execute_min_confidence"]:
        require_review = True

    auto_candidate = (
        classification.category in AUTO_EXECUTE_CLASSES
        and not sensitive_scope.is_sensitive
        and not missing_context
        and failures == 0
        and task_context.plan.status == "approved"
        and confidence_score >= thresholds["auto_execute_min_confidence"]
    )
    safe_retry_candidate = (
        previous_auto_safe
        and failures <= 1
        and confidence_score >= max(0.72, thresholds["review_min_confidence"])
        and not overrides.disable_retries
    )
    if auto_candidate or safe_retry_candidate:
        require_review = False
        require_approval = False
        require_qa = False

    escalation_reason = None
    if sensitive_scope.forbidden_actions:
        escalation_reason = ", ".join(sensitive_scope.forbidden_actions)
    elif failures >= 3:
        escalation_reason = "repeated_failures"
    elif chain_depth >= defaults["max_chain_depth"]:
        escalation_reason = "chain_depth_exceeded"
    elif block and missing_context:
        escalation_reason = "missing_context"

    retry_allowed = failures < defaults["max_retry"] and not block and not overrides.disable_retries
    reason_codes = _base_reason_codes(
        classification=classification,
        sensitive_scope=sensitive_scope,
        extra_codes=[*risk_flags, *("missing_context" for _ in missing_context[:1])],
    )
    if safe_retry_candidate:
        reason_codes.append("previous_safe_task_retry")
    if auto_candidate:
        reason_codes.append("approval_minimized")
    if overrides.applied:
        reason_codes.append("override_applied")
    evidence = {
        "task_status": task_context.task.status,
        "plan_status": task_context.plan.status,
        "missing_context": list(missing_context),
        "risk_flags": list(risk_flags),
        "chain_depth": chain_depth,
        "previous_failures": failures,
        "forbidden_actions": sensitive_scope.forbidden_actions,
    }
    contributing_factors = {
        "classification": classification.as_dict(),
        "sensitive_scope": sensitive_scope.as_dict(),
        "dispatch_readiness": dispatch_readiness.as_dict(),
        "execution_safety": execution_safety.as_dict(),
        "history": {
            "previous_failures": failures,
            "previous_auto_safe": previous_auto_safe,
            "chain_depth": chain_depth,
        },
    }

    return _finalize_decision(
        stage="dispatch",
        classification=classification,
        sensitive_scope=sensitive_scope,
        overrides=overrides,
        defaults=defaults,
        reason_codes=reason_codes,
        evidence=evidence,
        contributing_factors=contributing_factors,
        require_review=require_review,
        require_qa=require_qa,
        require_approval=require_approval,
        block=block,
        escalate=escalate,
        retry_allowed=retry_allowed,
        escalation_reason=escalation_reason,
        suggested_action="dispatch_execution",
        confidence_score=confidence_score,
    )


def evaluate_result_policy(
    session: Session,
    run_context: RunContext,
    *,
    risk_flags: Sequence[str],
    result_status: str,
    reviewer_decision: ReviewerDecisionRead,
    qa_decision: QADecisionRead,
) -> PolicyDecisionRead:
    overrides = resolve_overrides(
        session,
        project_id=run_context.task_context.project.id,
        task_id=run_context.task_context.task.id,
    )
    changed_files = extract_changed_files(run_context.execution_run.output_payload)
    classification = classify_task(run_context.task_context, changed_files=changed_files)
    sensitive_scope = detect_sensitive_scope(
        run_context.task_context,
        changed_files=changed_files,
        extra_sensitive_modules=overrides.sensitive_modules,
    )
    post_result = score_post_result_confidence(
        run_context.task_context,
        classification=classification,
        sensitive_scope=sensitive_scope,
        reviewer_decision=reviewer_decision,
        qa_decision=qa_decision,
        result_status=result_status,
        run_status=run_context.execution_run.status,
    )
    execution_safety = score_execution_safety(
        run_context.task_context,
        classification=classification,
        sensitive_scope=sensitive_scope,
    )
    confidence_score = min(post_result.score, execution_safety.score)
    thresholds = _thresholds(overrides)
    defaults = _loop_policy_defaults(run_context.task_context.task.task_type, classification.category, overrides)
    failures = previous_failure_count(run_context.task_context.execution_runs)

    hard_block = bool(sensitive_scope.forbidden_actions) or classification.category == "human_only"
    require_review = (
        reviewer_decision.status == "review_required"
        or reviewer_decision.scope_deviation
        or bool(reviewer_decision.risky_changes)
        or classification.category in REVIEW_CLASSES
    )
    require_qa = result_status == "qa_pending" or bool(qa_decision.missing_checks or qa_decision.potential_regressions)
    require_approval = (
        classification.category in APPROVAL_CLASSES
        or any(domain in HIGH_SENSITIVITY_DOMAINS for domain in sensitive_scope.domains)
        or run_context.task_context.plan.status != "approved"
    )
    escalate = failures >= 3 or reviewer_decision.scope_deviation
    block = hard_block or confidence_score < thresholds["block_below_confidence"]

    if confidence_score < thresholds["review_min_confidence"]:
        require_approval = True
    elif confidence_score < thresholds["auto_execute_min_confidence"]:
        require_review = True

    auto_candidate = (
        result_status == "passed"
        and classification.category in {*AUTO_EXECUTE_CLASSES, "bugfix"}
        and not sensitive_scope.is_sensitive
        and not reviewer_decision.scope_deviation
        and not qa_decision.missing_checks
        and confidence_score >= thresholds["auto_execute_min_confidence"]
    )
    if auto_candidate:
        require_review = False
        require_approval = False
        require_qa = False

    escalation_reason = None
    if sensitive_scope.forbidden_actions:
        escalation_reason = ", ".join(sensitive_scope.forbidden_actions)
    elif reviewer_decision.scope_deviation:
        escalation_reason = "scope_deviation"
    elif failures >= 3:
        escalation_reason = "repeated_failures"

    retry_allowed = (
        result_status in {"needs_rework", "blocked"}
        and failures < defaults["max_retry"]
        and not overrides.disable_retries
        and not block
    )
    reason_codes = _base_reason_codes(
        classification=classification,
        sensitive_scope=sensitive_scope,
        extra_codes=[*risk_flags, result_status],
    )
    if auto_candidate:
        reason_codes.append("approval_minimized")
    if overrides.applied:
        reason_codes.append("override_applied")
    evidence = {
        "run_status": run_context.execution_run.status,
        "result_status": result_status,
        "risk_flags": list(risk_flags),
        "changed_files": changed_files,
        "previous_failures": failures,
        "forbidden_actions": sensitive_scope.forbidden_actions,
        "reviewer_status": reviewer_decision.status,
        "qa_status": qa_decision.status,
    }
    contributing_factors = {
        "classification": classification.as_dict(),
        "sensitive_scope": sensitive_scope.as_dict(),
        "post_result_confidence": post_result.as_dict(),
        "execution_safety": execution_safety.as_dict(),
        "history": {"previous_failures": failures},
    }

    return _finalize_decision(
        stage="result",
        classification=classification,
        sensitive_scope=sensitive_scope,
        overrides=overrides,
        defaults=defaults,
        reason_codes=reason_codes,
        evidence=evidence,
        contributing_factors=contributing_factors,
        require_review=require_review,
        require_qa=require_qa,
        require_approval=require_approval,
        block=block,
        escalate=escalate,
        retry_allowed=retry_allowed,
        escalation_reason=escalation_reason,
        suggested_action="continue_loop",
        confidence_score=confidence_score,
    )


def evaluate_loop_policy(
    session: Session,
    task_context: TaskContext,
    *,
    loop_state,
    result_evaluation: ResultEvaluationRead,
    bug_triage: BugTriageRead,
    failure_patterns: Sequence[FailurePatternRead],
) -> PolicyDecisionRead:
    overrides = resolve_overrides(session, project_id=task_context.project.id, task_id=task_context.task.id)
    run_context = get_run_context(session, result_evaluation.run_id)
    changed_files = extract_changed_files(run_context.execution_run.output_payload)
    classification = classify_task(task_context, changed_files=changed_files)
    sensitive_scope = detect_sensitive_scope(
        task_context,
        changed_files=changed_files,
        extra_sensitive_modules=overrides.sensitive_modules,
    )
    defaults = _loop_policy_defaults(task_context.task.task_type, classification.category, overrides)
    thresholds = _thresholds(overrides)
    retry_viability = score_retry_viability(
        task_context,
        result_evaluation=result_evaluation,
        bug_triage=bug_triage,
        failure_patterns=failure_patterns,
        retry_count=loop_state.retry_count,
        max_retry=int(defaults["max_retry"]),
        retries_disabled=overrides.disable_retries,
    )
    confidence_score = retry_viability.score

    retry_budget_exceeded = loop_state.retry_count >= int(defaults["max_retry"])
    chain_depth_exceeded = loop_state.chain_depth >= int(defaults["max_chain_depth"])
    loop_timeout_exceeded = bool(loop_state.timeout_at and loop_state.timeout_at <= datetime.now(timezone.utc))
    recurring_patterns = [pattern for pattern in failure_patterns if pattern.recurring]

    hard_block = bool(sensitive_scope.forbidden_actions) or classification.category == "human_only"
    require_review = (
        result_evaluation.status == "awaiting_review"
        or bug_triage.category == "spec_issue"
    )
    require_qa = result_evaluation.status == "qa_pending" or (
        bug_triage.category == "test_issue" and result_evaluation.status == "passed"
    )
    require_approval = (
        classification.category in APPROVAL_CLASSES
        or any(domain in HIGH_SENSITIVITY_DOMAINS for domain in sensitive_scope.domains)
        or task_context.plan.status != "approved"
    )
    escalate = any(
        (
            retry_budget_exceeded,
            chain_depth_exceeded,
            loop_timeout_exceeded,
            bool(recurring_patterns),
            bug_triage.recommended_action == "escalate",
        )
    )
    block = hard_block or confidence_score < thresholds["block_below_confidence"]

    retry_allowed = (
        bug_triage.recommended_action == "retry"
        and not any((retry_budget_exceeded, chain_depth_exceeded, loop_timeout_exceeded, bool(recurring_patterns), block))
        and confidence_score >= max(0.45, thresholds["block_below_confidence"])
        and not overrides.disable_retries
    )

    suggested_action = "escalate_to_human"
    if result_evaluation.status == "passed" and not any((require_review, require_qa, require_approval, block, escalate)):
        suggested_action = "chain_next_task"
    elif retry_allowed:
        suggested_action = "schedule_retry"
    elif result_evaluation.status in {"needs_rework", "qa_pending"} or bug_triage.recommended_action == "fix_task":
        suggested_action = "create_follow_up_task"

    if (
        confidence_score < thresholds["auto_execute_min_confidence"]
        and suggested_action == "schedule_retry"
        and (classification.risk_level == "high" or sensitive_scope.is_sensitive)
    ):
        require_review = True

    escalation_reason = None
    if sensitive_scope.forbidden_actions:
        escalation_reason = ", ".join(sensitive_scope.forbidden_actions)
    elif retry_budget_exceeded:
        escalation_reason = "retry_budget_exceeded"
    elif chain_depth_exceeded:
        escalation_reason = "chain_depth_exceeded"
    elif loop_timeout_exceeded:
        escalation_reason = "loop_timeout_exceeded"
    elif recurring_patterns:
        escalation_reason = "recurring_failure_pattern"

    reason_codes = _base_reason_codes(
        classification=classification,
        sensitive_scope=sensitive_scope,
        extra_codes=[
            result_evaluation.status,
            bug_triage.category,
            *(pattern.pattern_key for pattern in recurring_patterns),
        ],
    )
    if overrides.applied:
        reason_codes.append("override_applied")
    evidence = {
        "retry_count": loop_state.retry_count,
        "chain_depth": loop_state.chain_depth,
        "result_status": result_evaluation.status,
        "bug_category": bug_triage.category,
        "failure_patterns": [pattern.pattern_key for pattern in failure_patterns],
        "forbidden_actions": sensitive_scope.forbidden_actions,
    }
    contributing_factors = {
        "classification": classification.as_dict(),
        "sensitive_scope": sensitive_scope.as_dict(),
        "retry_viability": retry_viability.as_dict(),
        "loop_state": {
            "retry_count": loop_state.retry_count,
            "chain_depth": loop_state.chain_depth,
            "timeout_at": loop_state.timeout_at.isoformat() if loop_state.timeout_at else None,
        },
    }

    return _finalize_decision(
        stage="loop",
        classification=classification,
        sensitive_scope=sensitive_scope,
        overrides=overrides,
        defaults=defaults,
        reason_codes=reason_codes,
        evidence=evidence,
        contributing_factors=contributing_factors,
        require_review=require_review,
        require_qa=require_qa,
        require_approval=require_approval,
        block=block,
        escalate=escalate,
        retry_allowed=retry_allowed,
        escalation_reason=escalation_reason,
        suggested_action=suggested_action,
        confidence_score=confidence_score,
    )
