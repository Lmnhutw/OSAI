import json
from typing import Any, List, Mapping

from pydantic import BaseModel, Field
from sqlmodel import Session, select

from ..models import Plan, ProjectRequirement, Task
from ..ai_runtime import ModelRuntime
from .agent_runtime import run_structured_agent


class GeneratedTask(BaseModel):
    title: str = Field(min_length=3, max_length=240)
    instructions: str = Field(min_length=10, max_length=6000)
    task_type: str = Field(default="implementation", min_length=2, max_length=80)
    input_payload: dict[str, Any] = Field(default_factory=dict)


class GeneratedTaskList(BaseModel):
    tasks: List[GeneratedTask] = Field(min_length=1, max_length=50)


def generate_tasks_for_plan(
    session: Session,
    plan: Plan,
    *,
    runtime: ModelRuntime | None = None,
    environ: Mapping[str, str] | None = None,
) -> List[Task]:
    """Decompose an approved plan through the configured reasoning model."""
    requirements: List[ProjectRequirement] = session.exec(
        select(ProjectRequirement)
        .where(ProjectRequirement.project_id == plan.project_id)
        .order_by(ProjectRequirement.position)
    ).all()
    generated, _ = run_structured_agent(
        session,
        agent_key="project_manager",
        project_id=plan.project_id,
        plan_id=plan.id,
        response_model=GeneratedTaskList,
        runtime=runtime,
        environ=environ,
        user_prompt=json.dumps(
            {
                "plan": {"title": plan.title, "summary": plan.summary},
                "requirements": [
                    {"position": requirement.position, "text": requirement.requirement_text}
                    for requirement in requirements
                ],
                "instruction": "Return an ordered, minimal task list with implementation details and a final verification task when needed.",
            }
        ),
    )
    tasks = [
        Task(
            plan_id=plan.id,
            position=position,
            task_type=item.task_type,
            title=item.title,
            instructions=item.instructions,
            status="pending",
            input_payload=item.input_payload,
        )
        for position, item in enumerate(generated.tasks, start=1)
    ]
    session.add_all(tasks)
    session.commit()
    for task in tasks:
        session.refresh(task)
    return tasks
