from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from typing import List
import uuid

from ..models import TaskSession, Event
from ..schemas import TaskSessionRead, EventRead
from ..database import get_session

router = APIRouter(prefix="/sessions", tags=["sessions"])

@router.get("/{session_id}", response_model=TaskSessionRead)
def get_task_session(session_id: uuid.UUID, session: Session = Depends(get_session)):
    task_session = session.get(TaskSession, session_id)
    if not task_session:
        raise HTTPException(status_code=404, detail="Session not found")
    return task_session

@router.get("/{session_id}/events", response_model=List[EventRead])
def list_session_events(session_id: uuid.UUID, session: Session = Depends(get_session)):
    task_session = session.get(TaskSession, session_id)
    if not task_session:
        raise HTTPException(status_code=404, detail="Session not found")
    events = session.exec(
        select(Event)
        .where(Event.task_session_id == session_id)
        .order_by(Event.occurred_at.desc())
    ).all()
    return events
