from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select
from typing import List, Optional
import uuid
from datetime import datetime, timezone

from ..models import Plan, Approval, Task, TaskSession, ExecutionRun
from ..schemas import ApprovalCreate, ApprovalRead, TaskRead, PlanRead, ExecutionRunRead
from ..database import get_session
from ..authz import approval_actor
from ..ai_runtime import ModelRuntimeError
from ..schemas import ApprovalRequestCreate
from ..services.approval_service import ApprovalConflictError, decide_plan_approval, request_plan_approval
from ..services.jira_integration import JiraConfigurationError, JiraSettings, auto_sync_generated_tasks
from ..services.pm_agent import generate_tasks_for_plan

router = APIRouter(prefix="/plans", tags=["plans"])


@router.get("", response_model=List[PlanRead])
def list_plans(
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    status: Optional[str] = Query(default=None, max_length=80),
    sort_by: str = Query(default="updated_at", pattern="^(updated_at|created_at|version)$"),
    sort_direction: str = Query(default="desc", pattern="^(asc|desc)$"),
    session: Session = Depends(get_session),
):
    statement = select(Plan)
    if status:
        statement = statement.where(Plan.status == status)
    sort_column = {"updated_at": Plan.updated_at, "created_at": Plan.created_at, "version": Plan.version}[sort_by]
    ordering = sort_column.asc() if sort_direction == "asc" else sort_column.desc()
    return session.exec(statement.order_by(ordering).offset(offset).limit(limit)).all()

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
    actor: str = Depends(approval_actor),
    session: Session = Depends(get_session)
):
    plan = session.get(Plan, plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
        
    if approval_in.requested_by != actor:
        raise HTTPException(status_code=403, detail="Approval requester must match the authenticated actor.")
    request_key = f"legacy-request:{plan.id}:{actor}:{plan.updated_at.isoformat()}"
    try:
        approval = request_plan_approval(
            session,
            plan=plan,
            actor=actor,
            note=approval_in.decision_note,
            expected_plan_updated_at=plan.updated_at,
            idempotency_key=request_key,
        )
        return decide_plan_approval(
            session,
            approval=approval,
            actor=f"legacy-approver:{actor}",
            decision="approved",
            note=approval_in.decision_note,
            expected_plan_updated_at=plan.updated_at,
            idempotency_key=f"legacy-decision:{approval.id}",
        )
    except ApprovalConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/{plan_id}/approval-requests", response_model=ApprovalRead, status_code=201)
def request_approval(
    plan_id: uuid.UUID,
    request_in: ApprovalRequestCreate,
    actor: str = Depends(approval_actor),
    session: Session = Depends(get_session),
):
    plan = session.get(Plan, plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    if request_in.requested_by != actor:
        raise HTTPException(status_code=403, detail="Approval requester must match the authenticated actor.")
    try:
        return request_plan_approval(
            session,
            plan=plan,
            actor=actor,
            note=request_in.decision_note,
            expected_plan_updated_at=request_in.expected_plan_updated_at,
            idempotency_key=request_in.idempotency_key,
        )
    except ApprovalConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

@router.post("/{plan_id}/tasks/generate", response_model=List[TaskRead])
def generate_tasks(
    plan_id: uuid.UUID,
    actor: str = Depends(approval_actor),
    session: Session = Depends(get_session)
):
    plan = session.get(Plan, plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
        
    if plan.status != "approved":
        raise HTTPException(status_code=400, detail="Cannot generate tasks for an unapproved plan")

    try:
        # Validate before invoking the model so a bad Jira configuration cannot
        # leave a successful task generation request with a later 5xx response.
        JiraSettings.from_environment()
        tasks = generate_tasks_for_plan(session, plan)
        auto_sync_generated_tasks(session, tasks)
        return tasks
    except ModelRuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except JiraConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

