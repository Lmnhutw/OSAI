from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from typing import List
import uuid
from datetime import datetime, timezone

from ..models import Plan, Approval, Task, TaskSession, ExecutionRun
from ..schemas import ApprovalCreate, ApprovalRead, TaskRead, PlanRead, ExecutionRunRead
from ..database import get_session
from ..services.pm_agent import generate_tasks_for_plan

router = APIRouter(prefix="/plans", tags=["plans"])

@router.get("/{plan_id}", response_model=PlanRead)
def get_plan(plan_id: uuid.UUID, session: Session = Depends(get_session)):
    plan = session.get(Plan, plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    return plan

@router.get("/{plan_id}/approvals", response_model=List[ApprovalRead])
def list_plan_approvals(plan_id: uuid.UUID, session: Session = Depends(get_session)):
    plan = session.get(Plan, plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    approvals = session.exec(
        select(Approval)
        .where(Approval.plan_id == plan_id)
        .order_by(Approval.requested_at.desc())
    ).all()
    return approvals

@router.get("/{plan_id}/tasks", response_model=List[TaskRead])
def list_plan_tasks(plan_id: uuid.UUID, session: Session = Depends(get_session)):
    plan = session.get(Plan, plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    tasks = session.exec(
        select(Task)
        .where(Task.plan_id == plan_id)
        .order_by(Task.position)
    ).all()
    return tasks

@router.get("/{plan_id}/runs", response_model=List[ExecutionRunRead])
def list_plan_runs(plan_id: uuid.UUID, session: Session = Depends(get_session)):
    plan = session.get(Plan, plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    # Join through tasks -> task_sessions -> execution_runs
    runs = session.exec(
        select(ExecutionRun)
        .join(TaskSession, ExecutionRun.task_session_id == TaskSession.id)
        .join(Task, TaskSession.task_id == Task.id)
        .where(Task.plan_id == plan_id)
        .order_by(ExecutionRun.created_at.desc())
    ).all()
    return runs

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

