from __future__ import annotations

from datetime import datetime, timezone

from sqlmodel import Session, select

from ..models import Approval, Plan
from .control_plane_support import create_event


class ApprovalConflictError(RuntimeError):
    pass


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _assert_expected_version(plan: Plan, expected: datetime | None) -> None:
    if expected is None:
        return
    if _as_utc(plan.updated_at) != _as_utc(expected):
        raise ApprovalConflictError("Plan changed since it was viewed; refresh and review it again.")


def request_plan_approval(
    session: Session,
    *,
    plan: Plan,
    actor: str,
    note: str | None,
    expected_plan_updated_at: datetime | None,
    idempotency_key: str,
) -> Approval:
    _assert_expected_version(plan, expected_plan_updated_at)
    existing = session.exec(
        select(Approval).where(Approval.plan_id == plan.id, Approval.idempotency_key == idempotency_key)
    ).first()
    if existing:
        return existing
    pending = session.exec(
        select(Approval).where(Approval.plan_id == plan.id, Approval.status == "pending")
    ).first()
    if pending:
        raise ApprovalConflictError("A plan approval request is already pending.")
    if plan.status not in {"draft", "needs_changes"}:
        raise ApprovalConflictError(f"Plan cannot request approval from status '{plan.status}'.")

    approval = Approval(
        plan_id=plan.id,
        requested_by=actor,
        status="pending",
        decision_note=note,
        expected_plan_updated_at=expected_plan_updated_at,
        idempotency_key=idempotency_key,
    )
    session.add(approval)
    create_event(
        session,
        project_id=plan.project_id,
        plan_id=plan.id,
        event_source="control_plane.approval_service",
        event_type="approval.requested",
        payload={"approval_id": str(approval.id), "actor": actor, "idempotency_key": idempotency_key},
    )
    session.commit()
    session.refresh(approval)
    return approval


def decide_plan_approval(
    session: Session,
    *,
    approval: Approval,
    actor: str,
    decision: str,
    note: str | None,
    expected_plan_updated_at: datetime | None,
    idempotency_key: str,
) -> Approval:
    prior_decision = session.exec(
        select(Approval).where(Approval.decision_idempotency_key == idempotency_key)
    ).first()
    if prior_decision:
        return prior_decision
    if approval.status != "pending":
        raise ApprovalConflictError(f"Approval was already decided with status '{approval.status}'.")
    if approval.requested_by == actor:
        raise ApprovalConflictError("The requesting actor cannot decide their own approval.")

    plan = session.get(Plan, approval.plan_id)
    if not plan:
        raise LookupError("Plan not found")
    _assert_expected_version(plan, expected_plan_updated_at or approval.expected_plan_updated_at)

    approval.status = decision
    approval.approver = actor
    approval.decision_note = note
    approval.decided_at = _utcnow()
    approval.decision_idempotency_key = idempotency_key
    plan.status = "approved" if decision == "approved" else "needs_changes"
    plan.updated_at = _utcnow()
    create_event(
        session,
        project_id=plan.project_id,
        plan_id=plan.id,
        event_source="control_plane.approval_service",
        event_type="approval.decided",
        payload={
            "approval_id": str(approval.id),
            "actor": actor,
            "decision": decision,
            "idempotency_key": idempotency_key,
        },
    )
    session.add(plan)
    session.add(approval)
    session.commit()
    session.refresh(approval)
    return approval
