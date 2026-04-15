from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select
from typing import List
import uuid

from ..models import Project, ProjectRequirement, Plan
from ..schemas import (
    PlanRead,
    ProjectAutonomySummaryRead,
    ProjectCreate,
    ProjectRead,
    ProjectRequirementCreate,
    ProjectRequirementRead,
)
from ..database import get_session
from ..services.autonomy_service import get_project_autonomy_summary
from ..services.planner_agent import generate_plan_for_project

router = APIRouter(prefix="/projects", tags=["projects"])

@router.get("", response_model=List[ProjectRead])
def list_projects(session: Session = Depends(get_session)):
    projects = session.exec(select(Project).order_by(Project.created_at.desc())).all()
    return projects

@router.get("/{project_id}", response_model=ProjectRead)
def get_project(project_id: uuid.UUID, session: Session = Depends(get_session)):
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project

@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
def create_project(project_in: ProjectCreate, session: Session = Depends(get_session)):
    project = Project(name=project_in.name, description=project_in.description)
    session.add(project)
    session.commit()
    session.refresh(project)
    return project

@router.get("/{project_id}/requirements", response_model=List[ProjectRequirementRead])
def list_project_requirements(project_id: uuid.UUID, session: Session = Depends(get_session)):
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    reqs = session.exec(
        select(ProjectRequirement)
        .where(ProjectRequirement.project_id == project_id)
        .order_by(ProjectRequirement.position)
    ).all()
    return reqs

@router.post("/{project_id}/requirements", response_model=List[ProjectRequirementRead])
def add_project_requirements(
    project_id: uuid.UUID,
    requirements_in: List[ProjectRequirementCreate],
    session: Session = Depends(get_session)
):
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    new_reqs = []
    for req in requirements_in:
        db_req = ProjectRequirement(
            project_id=project.id,
            position=req.position,
            requirement_text=req.requirement_text
        )
        session.add(db_req)
        new_reqs.append(db_req)

    session.commit()
    for req in new_reqs:
        session.refresh(req)
        
    return new_reqs

@router.get("/{project_id}/plans", response_model=List[PlanRead])
def list_project_plans(project_id: uuid.UUID, session: Session = Depends(get_session)):
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    plans = session.exec(
        select(Plan)
        .where(Plan.project_id == project_id)
        .order_by(Plan.version.desc())
    ).all()
    return plans

@router.get("/{project_id}/autonomy-summary", response_model=ProjectAutonomySummaryRead)
def autonomy_summary(project_id: uuid.UUID, session: Session = Depends(get_session)):
    try:
        return get_project_autonomy_summary(session, project_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

@router.post("/{project_id}/plan/generate", response_model=PlanRead)
def generate_plan(
    project_id: uuid.UUID,
    session: Session = Depends(get_session)
):
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
        
    # Check if there are requirements
    reqs = session.exec(select(ProjectRequirement).where(ProjectRequirement.project_id == project.id)).all()
    if not reqs:
        raise HTTPException(status_code=400, detail="Cannot generate plan without requirements")
        
    plan = generate_plan_for_project(session, project)
    return plan

