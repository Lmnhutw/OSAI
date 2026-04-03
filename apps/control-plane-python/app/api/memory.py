from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session
import uuid

from ..database import get_session
from ..schemas import MemoryCurateRequest, MemoryCurateResponse, ProjectMemoryRead, TaskMemoryRead
from ..services.memory_curator import curate_memory, get_project_memory, get_task_memory

router = APIRouter(prefix="/memory", tags=["memory"])


@router.post("/curate", response_model=MemoryCurateResponse)
def curate_memory_endpoint(
    request: MemoryCurateRequest,
    session: Session = Depends(get_session)
):
    return curate_memory(session, request)


@router.get("/project/{project_id}", response_model=ProjectMemoryRead)
def get_project_memory_endpoint(
    project_id: uuid.UUID,
    session: Session = Depends(get_session)
):
    try:
        return get_project_memory(session, project_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/task/{task_id}", response_model=TaskMemoryRead)
def get_task_memory_endpoint(
    task_id: uuid.UUID,
    session: Session = Depends(get_session)
):
    try:
        return get_task_memory(session, task_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
