from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_
from sqlmodel import Session, select

from ..database import get_session
from ..models import Plan, Project, Task
from ..schemas import SearchItemRead, SearchResponseRead

router = APIRouter(prefix="/search", tags=["search"])


@router.get("", response_model=SearchResponseRead)
def search_resources(
    q: str = Query(min_length=2, max_length=160),
    limit: int = Query(default=30, ge=1, le=100),
    session: Session = Depends(get_session),
):
    query = q.strip()
    pattern = f"%{query}%"
    items: list[SearchItemRead] = []
    for project in session.exec(select(Project).where(Project.name.ilike(pattern)).limit(limit)).all():
        items.append(SearchItemRead(resource_type="project", resource_id=project.id, title=project.name, subtitle=project.description, status=project.status))
    for plan in session.exec(select(Plan).where(or_(Plan.title.ilike(pattern), Plan.summary.ilike(pattern))).limit(limit)).all():
        items.append(SearchItemRead(resource_type="plan", resource_id=plan.id, project_id=plan.project_id, title=plan.title, subtitle=plan.summary, status=plan.status))
    for task, plan in session.exec(select(Task, Plan).join(Plan, Task.plan_id == Plan.id).where(or_(Task.title.ilike(pattern), Task.instructions.ilike(pattern))).limit(limit)).all():
        items.append(SearchItemRead(resource_type="task", resource_id=task.id, project_id=plan.project_id, plan_id=plan.id, title=task.title, subtitle=task.instructions, status=task.status))
    return SearchResponseRead(query=query, items=items[:limit])
