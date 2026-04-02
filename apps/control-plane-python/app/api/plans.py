from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session
from typing import List
import uuid
from datetime import datetime, timezone

from ..models import Plan, Approval
from ..schemas import ApprovalCreate, ApprovalRead, TaskRead
from ..database import get_session
from ..services.pm_agent import generate_tasks_for_plan

router = APIRouter(prefix="/plans", tags=["plans"])

@router.post("/{plan_id}/approve", response_model=ApprovalRead)
def approve_plan(
    plan_id: uuid.UUID,
    approval_in: ApprovalCreate,
    session: Session = Depends(get_session)
):
    plan = session.get(Plan, plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
        
    approval = Approval(
        plan_id=plan.id,
        requested_by=approval_in.requested_by,
        status="approved",
        approver=approval_in.requested_by, # Assume requested_by is also approver for now
        decision_note=approval_in.decision_note,
        decided_at=datetime.now(timezone.utc)
    )
    
    plan.status = "approved"
    
    session.add(approval)
    session.add(plan)
    session.commit()
    session.refresh(approval)
    
    return approval

@router.post("/{plan_id}/tasks/generate", response_model=List[TaskRead])
def generate_tasks(
    plan_id: uuid.UUID,
    session: Session = Depends(get_session)
):
    plan = session.get(Plan, plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
        
    if plan.status != "approved":
        raise HTTPException(status_code=400, detail="Cannot generate tasks for an unapproved plan")
        
    tasks = generate_tasks_for_plan(session, plan)
    return tasks
