from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from typing import List

from ..models import Task
from ..schemas import BatchTaskApprove, TaskRead
from ..database import get_session

router = APIRouter(prefix="/tasks", tags=["tasks"])

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
