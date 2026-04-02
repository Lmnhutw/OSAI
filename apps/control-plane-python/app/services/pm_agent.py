from typing import List
from ..models import Plan, Task, ProjectRequirement
from sqlmodel import Session, select

def generate_tasks_for_plan(session: Session, plan: Plan) -> List[Task]:
    """
    Mock PM Agent that breaks down a given (approved) plan into achievable tasks.
    In a real scenario, an LLM would map plan requirements to concrete execution steps
    and return JSON objects matching the 'Task' structure.
    """
    
    # 1. Fetch requirements for context
    reqs: List[ProjectRequirement] = session.exec(
        select(ProjectRequirement).where(ProjectRequirement.project_id == plan.project_id).order_by(ProjectRequirement.position)
    ).all()
    
    # If tasks already exist, we may skip or override depending on behavior. 
    # Here, we assume a fresh plan means generating new tasks.
    
    tasks = []
    
    # 2. "Generate" tasks (Mock breakdown based on requirements)
    # We will just generate one 'generic' task per requirement for simplicity.
    for idx, req in enumerate(reqs, start=1):
        t = Task(
            plan_id=plan.id,
            position=idx,
            task_type="generic",
            title=f"Implement requirement {idx}",
            instructions=f"Based on requirement: '{req.requirement_text}', please implement the related logic.",
            status="pending", # Start pending until approved
            input_payload={"extracted_entities": ["mock_entity_1"]}
        )
        tasks.append(t)
        session.add(t)
        
    # We could also add a final "Verification" task that blocks on everything else
    t_final = Task(
        plan_id=plan.id,
        position=len(reqs) + 1,
        task_type="verification",
        title="Verify all implementations",
        instructions="Run test suites on the newly implemented modules.",
        status="pending",
        input_payload={}
    )
    tasks.append(t_final)
    session.add(t_final)
    
    session.commit()
    for t in tasks:
        session.refresh(t)
        
    return tasks
