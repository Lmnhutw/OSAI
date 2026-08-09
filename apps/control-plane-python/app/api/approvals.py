import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from ..authz import approval_actor
from ..database import get_session
from ..models import Approval
from ..schemas import ApprovalDecisionCreate, ApprovalRead
from ..services.approval_service import ApprovalConflictError, decide_plan_approval

router = APIRouter(prefix="/approvals", tags=["approvals"])


@router.post("/{approval_id}/decision", response_model=ApprovalRead)
def decide_approval(
    approval_id: uuid.UUID,
    decision_in: ApprovalDecisionCreate,
    actor: str = Depends(approval_actor),
    session: Session = Depends(get_session),
):
    approval = session.get(Approval, approval_id)
    if not approval:
        raise HTTPException(status_code=404, detail="Approval not found")
    try:
        return decide_plan_approval(
            session,
            approval=approval,
            actor=actor,
            decision=decision_in.decision,
            note=decision_in.decision_note,
            expected_plan_updated_at=decision_in.expected_plan_updated_at,
            idempotency_key=decision_in.idempotency_key,
        )
    except ApprovalConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
