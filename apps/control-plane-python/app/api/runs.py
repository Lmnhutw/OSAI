from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select
from typing import List, Optional
import uuid

from ..models import ExecutionRun, Event
from ..database import get_session
from ..schemas import EventRead, ExecutionRunRead, ResultEvaluationRead
from ..services.result_evaluator import evaluate_run_result

router = APIRouter(prefix="/runs", tags=["runs"])


@router.get("", response_model=List[ExecutionRunRead])
def list_runs(
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    status: Optional[str] = Query(default=None, max_length=80),
    sort_by: str = Query(default="created_at", pattern="^(created_at|started_at|attempt_no)$"),
    sort_direction: str = Query(default="desc", pattern="^(asc|desc)$"),
    session: Session = Depends(get_session),
):
    statement = select(ExecutionRun)
    if status:
        statement = statement.where(ExecutionRun.status == status)
    sort_column = {
        "created_at": ExecutionRun.created_at,
        "started_at": ExecutionRun.started_at,
        "attempt_no": ExecutionRun.attempt_no,
    }[sort_by]
    ordering = sort_column.asc() if sort_direction == "asc" else sort_column.desc()
    return session.exec(statement.order_by(ordering).offset(offset).limit(limit)).all()


@router.get("/{run_id}", response_model=ExecutionRunRead)
def get_run(run_id: uuid.UUID, session: Session = Depends(get_session)):
    run = session.get(ExecutionRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


@router.get("/{run_id}/events", response_model=List[EventRead])
def list_run_events(run_id: uuid.UUID, session: Session = Depends(get_session)):
    run = session.get(ExecutionRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    events = session.exec(
        select(Event)
        .where(Event.execution_run_id == run_id)
        .order_by(Event.occurred_at.desc())
    ).all()
    return events


@router.post("/{run_id}/evaluate-result", response_model=ResultEvaluationRead)
def evaluate_result(
    run_id: uuid.UUID,
    session: Session = Depends(get_session)
):
    try:
        return evaluate_run_result(session, run_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
