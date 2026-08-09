import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select

from ..database import get_session
from ..models import Approval, Plan, Task
from ..schemas import (
    OperatorQueueItemRead,
    OperatorQueueRead,
    ProjectOverviewRead,
    RunInspectionRead,
    TaskWorkbenchRead,
)
from ..services.dashboard_read_models import project_overview, run_inspection, task_workbench

router = APIRouter(prefix="/operator", tags=["operator"])

ACTIONABLE_TASK_STATUSES = {
    "awaiting_approval",
    "awaiting_review",
    "needs_context",
    "dispatch_blocked",
}


@router.get("/queue", response_model=OperatorQueueRead)
def get_operator_queue(
    limit: int = Query(default=50, ge=1, le=200),
    session: Session = Depends(get_session),
):
    """A compact, server-derived queue for work that needs an operator decision."""
    items: list[OperatorQueueItemRead] = []

    pending_approvals = session.exec(
        select(Approval, Plan)
        .join(Plan, Approval.plan_id == Plan.id)
        .where(Approval.status == "pending")
        .order_by(Approval.requested_at.desc())
    ).all()
    for approval, plan in pending_approvals:
        items.append(
            OperatorQueueItemRead(
                item_type="plan_approval",
                status=approval.status,
                title=plan.title,
                project_id=plan.project_id,
                plan_id=plan.id,
                approval_id=approval.id,
                requested_by=approval.requested_by,
                created_at=approval.requested_at,
            )
        )

    actionable_tasks = session.exec(
        select(Task, Plan)
        .join(Plan, Task.plan_id == Plan.id)
        .where(Task.status.in_(ACTIONABLE_TASK_STATUSES))
        .order_by(Task.updated_at.desc())
    ).all()
    for task, plan in actionable_tasks:
        items.append(
            OperatorQueueItemRead(
                item_type="task_attention",
                status=task.status,
                title=task.title,
                project_id=plan.project_id,
                plan_id=plan.id,
                task_id=task.id,
                created_at=task.updated_at,
            )
        )

    items.sort(key=lambda item: item.created_at, reverse=True)
    return OperatorQueueRead(items=items[:limit], total=len(items), limit=limit)


@router.get("/projects/{project_id}/overview", response_model=ProjectOverviewRead)
def get_project_overview(project_id: uuid.UUID, session: Session = Depends(get_session)):
    try:
        return project_overview(session, project_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/tasks/{task_id}/workbench", response_model=TaskWorkbenchRead)
def get_task_workbench(task_id: uuid.UUID, session: Session = Depends(get_session)):
    try:
        return task_workbench(session, task_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/runs/{run_id}/inspection", response_model=RunInspectionRead)
def get_run_inspection(run_id: uuid.UUID, session: Session = Depends(get_session)):
    try:
        return run_inspection(session, run_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
