from typing import List
from ..models import Project, ProjectRequirement, Plan
from sqlmodel import Session, select

def generate_plan_for_project(session: Session, project: Project) -> Plan:
    """
    Mock Planner Agent that generates a structured plan based on requirements.
    In a real scenario, this would format requirements as an LLM prompt
    and parse the generated JSON back into a Plan object.
    """
    
    # 1. Fetch requirements
    reqs: List[ProjectRequirement] = session.exec(
        select(ProjectRequirement).where(ProjectRequirement.project_id == project.id).order_by(ProjectRequirement.position)
    ).all()
    
    # 2. Determine next plan version
    existing_plans = session.exec(
        select(Plan).where(Plan.project_id == project.id).order_by(Plan.version.desc())
    ).all()
    
    next_version = 1
    if existing_plans:
        next_version = existing_plans[0].version + 1

    # 3. "Generate" structured output (Mock)
    req_summary = ", ".join([r.requirement_text for r in reqs[:2]])
    title = f"Execution Plan v{next_version} for {project.name}"
    summary = f"Generated plan addressing {len(reqs)} requirements. Highlights: {req_summary}..."
    
    # Create the Plan
    new_plan = Plan(
        project_id=project.id,
        version=next_version,
        title=title,
        summary=summary,
        status="draft" # Starts as draft, needs approval
    )
    
    session.add(new_plan)
    session.commit()
    session.refresh(new_plan)
    
    return new_plan
