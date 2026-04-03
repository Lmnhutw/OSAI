from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from typing import List
import uuid

from ..models import ExecutionRun, Event
from ..database import get_session
from ..schemas import EventRead, ExecutionRunRead, ResultEvaluationRead
from ..services.result_evaluator import evaluate_run_result

router = APIRouter(prefix="/runs", tags=["runs"])


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
