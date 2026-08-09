from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlmodel import Session
from sqlmodel import select

from ..ai_models import AutonomyDecision, ExecutionContract, TaskClassification
from ..schemas import PolicyDecisionRead
from .control_plane_support import TaskContext, create_event

POLICY_VERSION = "phase4"


def _execution_mode(policy: PolicyDecisionRead) -> str:
    if policy.block:
        return "blocked"
    if policy.allow_auto_execute:
        return "execute_with_validation"
    return "inspect_only"


def _contract_actions(execution_mode: str) -> list[str]:
    if execution_mode == "execute_with_validation":
        return ["prepare_workspace", "run_codex", "write_workspace", "run_validation"]
    if execution_mode == "inspect_only":
        return ["prepare_workspace", "inspect_workspace"]
    return ["halt_task"]


def record_persistent_execution_contract(
    session: Session,
    *,
    task_context: TaskContext,
    stage: str,
    policy_decision: PolicyDecisionRead,
    task_status: str,
    run_id=None,
) -> ExecutionContract | None:
    """Persist policy evidence and, for dispatch, the exact worker contract.

    The JSON payload is a compatibility projection for the current worker. The
    execution_contracts row is the source of truth and has the immutable ID.
    """
    now = datetime.now(timezone.utc)
    task = task_context.task
    classification = TaskClassification(
        task_id=task.id,
        task_class=policy_decision.task_classification,
        risk_level=policy_decision.task_risk_level,
        sensitivity_flags=policy_decision.sensitive_scope,
        confidence_inputs=policy_decision.contributing_factors,
        updated_at=now,
    )
    session.merge(classification)

    requires_human = policy_decision.approval_required or policy_decision.review_required
    decision = AutonomyDecision(
        project_id=task_context.project.id,
        task_id=task.id,
        related_run_id=run_id,
        autonomy_mode=policy_decision.autonomy_mode,
        approval_required=policy_decision.approval_required,
        review_required=policy_decision.review_required,
        confidence_score=policy_decision.confidence_score,
        escalation_reason=policy_decision.escalation_reason or ("human_review_required" if requires_human else None),
        allowed_actions=policy_decision.allowed_actions,
        sensitive_scope_flags=policy_decision.sensitive_scope,
        decision_summary="; ".join(policy_decision.reason_codes) or policy_decision.final_action,
        evidence_payload={
            "stage": stage,
            "task_status": task_status,
            "policy_decision": policy_decision.model_dump(mode="json"),
        },
    )
    session.add(decision)
    session.flush()

    if stage != "dispatch":
        return None

    execution_mode = _execution_mode(policy_decision)
    approval_state = "not_required" if not policy_decision.approval_required else "pending"
    contract = ExecutionContract(
        task_id=task.id,
        autonomy_decision_id=decision.id,
        execution_mode=execution_mode,
        allowed_actions=_contract_actions(execution_mode),
        retry_limit=policy_decision.max_retry if policy_decision.retry_allowed else 0,
        branch_policy="require_sandbox_branch",
        write_permission="workspace_only" if execution_mode == "execute_with_validation" else "none",
        approval_state=approval_state,
        expires_at=now + timedelta(hours=2),
    )
    session.add(contract)
    session.flush()

    payload = dict(task.input_payload or {})
    payload["execution_contract"] = {
        "id": str(contract.id),
        "task_id": str(task.id),
        "execution_mode": contract.execution_mode,
        "allowed_actions": contract.allowed_actions,
        "retry": {"allowed": policy_decision.retry_allowed, "max_retry": contract.retry_limit},
        "branch_policy": {
            "target_branch": f"codex/osai-{task.id}",
            "approved_target_branch": f"codex/osai-{task.id}",
            "allowed_target_branches": [f"codex/osai-{task.id}"],
            "require_approved_target": True,
            "approved": approval_state == "approved" or approval_state == "not_required",
        },
        "write_permissions": {
            "allow_write": contract.write_permission == "workspace_only",
            "read_only": execution_mode == "inspect_only",
            "dry_run": execution_mode != "execute_with_validation",
            "workspace_only": True,
            "no_autonomous_write": execution_mode != "execute_with_validation",
        },
        "approval": {
            "required": policy_decision.approval_required,
            "approved": approval_state in {"approved", "not_required"},
            "reference": f"autonomy://decision/{decision.id}",
        },
        "expires_at": contract.expires_at.isoformat() if contract.expires_at else None,
        "policy_version": POLICY_VERSION,
        "autonomy_reasoning_ref": f"autonomy://decision/{decision.id}",
    }
    payload["policy_snapshot"] = {
        "version": POLICY_VERSION,
        **policy_decision.model_dump(mode="json"),
    }
    task.input_payload = payload
    task.updated_at = now
    session.add(task)
    create_event(
        session,
        project_id=task_context.project.id,
        plan_id=task_context.plan.id,
        task_id=task.id,
        event_source="control_plane.execution_contract_service",
        event_type="execution.contract_issued",
        payload={
            "execution_contract_id": str(contract.id),
            "autonomy_decision_id": str(decision.id),
            "execution_mode": contract.execution_mode,
            "approval_state": contract.approval_state,
            "expires_at": contract.expires_at.isoformat() if contract.expires_at else None,
        },
    )
    return contract


def issue_operator_approved_execution_contract(
    session: Session,
    *,
    task_context: TaskContext,
    actor: str,
) -> ExecutionContract:
    """Append an operator-approved contract after reviewing a dispatch decision."""
    source = session.exec(
        select(ExecutionContract)
        .where(ExecutionContract.task_id == task_context.task.id)
        .order_by(ExecutionContract.issued_at.desc())
    ).first()
    if not source:
        raise LookupError("Evaluate task dispatch before approving execution.")

    now = datetime.now(timezone.utc)
    contract = ExecutionContract(
        task_id=task_context.task.id,
        autonomy_decision_id=source.autonomy_decision_id,
        execution_mode="execute_with_validation",
        allowed_actions=_contract_actions("execute_with_validation"),
        retry_limit=source.retry_limit,
        branch_policy="require_sandbox_branch",
        write_permission="workspace_only",
        approval_state="approved",
        expires_at=now + timedelta(hours=2),
    )
    session.add(contract)
    session.flush()
    task = task_context.task
    payload = dict(task.input_payload or {})
    payload["execution_contract"] = {
        "id": str(contract.id),
        "task_id": str(task.id),
        "execution_mode": contract.execution_mode,
        "allowed_actions": contract.allowed_actions,
        "retry": {"allowed": contract.retry_limit > 0, "max_retry": contract.retry_limit},
        "branch_policy": {
            "target_branch": f"codex/osai-{task.id}",
            "approved_target_branch": f"codex/osai-{task.id}",
            "allowed_target_branches": [f"codex/osai-{task.id}"],
            "require_approved_target": True,
            "approved": True,
        },
        "write_permissions": {
            "allow_write": True,
            "read_only": False,
            "dry_run": False,
            "workspace_only": True,
            "no_autonomous_write": False,
        },
        "approval": {
            "required": True,
            "approved": True,
            "reference": f"operator://approval/{actor}",
            "approved_by": actor,
            "approved_at": now.isoformat(),
        },
        "expires_at": contract.expires_at.isoformat(),
        "policy_version": POLICY_VERSION,
        "autonomy_reasoning_ref": f"autonomy://decision/{source.autonomy_decision_id}",
    }
    policy_snapshot = dict(payload.get("policy_snapshot") or {})
    policy_snapshot.update({"review_required": False, "approval_required": True})
    payload["policy_snapshot"] = policy_snapshot
    task.input_payload = payload
    task.updated_at = now
    session.add(task)
    create_event(
        session,
        project_id=task_context.project.id,
        plan_id=task_context.plan.id,
        task_id=task.id,
        event_source="control_plane.execution_contract_service",
        event_type="execution.contract_operator_approved",
        payload={"execution_contract_id": str(contract.id), "actor": actor},
    )
    return contract
