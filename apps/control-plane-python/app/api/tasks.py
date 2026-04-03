from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from typing import List
import uuid

from ..models import Task, TaskDependency, TaskSession, ExecutionRun
from ..schemas import (
    BatchTaskApprove,
    DispatchEvaluationRead,
    ExecutionRunRead,
    TaskDependencyRead,
    TaskRead,
    TaskSessionRead,
)
from ..database import get_session
from ..services.dispatch_evaluator import evaluate_task_dispatch

router = APIRouter(prefix="/tasks", tags=["tasks"])

@router.get("/{task_id}", response_model=TaskRead)
def get_task(task_id: uuid.UUID, session: Session = Depends(get_session)):
    task = session.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task

@router.get("/{task_id}/dependencies", response_model=List[TaskDependencyRead])
def list_task_dependencies(task_id: uuid.UUID, session: Session = Depends(get_session)):
    task = session.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    deps = session.exec(
        select(TaskDependency)
        .where(TaskDependency.task_id == task_id)
        .order_by(TaskDependency.created_at)
    ).all()
    return deps

@router.get("/{task_id}/sessions", response_model=List[TaskSessionRead])
def list_task_sessions(task_id: uuid.UUID, session: Session = Depends(get_session)):
    task = session.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    sessions = session.exec(
        select(TaskSession)
        .where(TaskSession.task_id == task_id)
        .order_by(TaskSession.started_at.desc())
    ).all()
    return sessions

@router.get("/{task_id}/runs", response_model=List[ExecutionRunRead])
def list_task_runs(task_id: uuid.UUID, session: Session = Depends(get_session)):
    task = session.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    runs = session.exec(
        select(ExecutionRun)
        .join(TaskSession, ExecutionRun.task_session_id == TaskSession.id)
        .where(TaskSession.task_id == task_id)
        .order_by(ExecutionRun.created_at.desc())
    ).all()
    return runs

@router.post("/batch/approve", response_model=List[TaskRead])
def approve_tasks_batch(
    approval_in: BatchTaskApprove,
    session: Session = Depends(get_session)
):
    # Fetch all tasks matching the provided IDs
    tasks = session.exec(select(Task).where(Task.id.in_(approval_in.task_ids))).all()
    
    if not tasks:
        raise HTTPException(status_code=404, detail="No tasks found for the provided IDs")
    
    # Optional context: if we need to verify they are all pending
    for task in tasks:
        if task.status == "pending":
            task.status = "approved"
            session.add(task)
            
    session.commit()
    for task in tasks:
        session.refresh(task)
        
    return tasks

@router.post("/{task_id}/evaluate-dispatch", response_model=DispatchEvaluationRead)
def evaluate_dispatch(
    task_id: uuid.UUID,
    session: Session = Depends(get_session)
):
    try:
        return evaluate_task_dispatch(session, task_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
