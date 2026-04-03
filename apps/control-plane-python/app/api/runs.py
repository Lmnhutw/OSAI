from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from typing import List
import uuid

from ..models import ExecutionRun, Event
from ..schemas import ExecutionRunRead, EventRead
from ..database import get_session

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
