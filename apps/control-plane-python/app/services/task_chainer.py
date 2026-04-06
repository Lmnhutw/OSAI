from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlmodel import Session, select

from ..models import Task, TaskDependency, TaskRelationship
from ..schemas import FollowUpTaskCreateRequest, ResultEvaluationRead
from .control_plane_support import (
    TaskContext,
    extract_acceptance_criteria,
    extract_constraints,
    get_task_relationships,
    is_dependency_satisfied,
    next_task_position,
)


def create_linked_task(
    session: Session,
    *,
    parent_task: Task,
    relation_type: str,
    title: str,
    instructions: str,
    task_type: str,
    input_payload: Optional[Dict[str, Any]] = None,
    create_dependency: bool,
    dependency_type: str = "blocks",
    relationship_metadata: Optional[Dict[str, Any]] = None,
    initial_status: str = "pending",
) -> Tuple[Task, TaskRelationship, Optional[TaskDependency], bool]:
    relationship_metadata = relationship_metadata or {}
    existing_relationships = get_task_relationships(
        session,
        parent_task_id=parent_task.id,
        relationship_type=relation_type,
    )
    idempotency_key = relationship_metadata.get("idempotency_key")
    if idempotency_key:
        for relationship in existing_relationships:
            if relationship.relationship_metadata.get("idempotency_key") == idempotency_key:
                existing_child = session.get(Task, relationship.child_task_id)
                dependency = session.exec(
                    select(TaskDependency).where(
                        TaskDependency.task_id == relationship.child_task_id,
                        TaskDependency.depends_on_task_id == parent_task.id,
                    )
                ).first()
                if existing_child:
                    return existing_child, relationship, dependency, False

    child_task = Task(
        plan_id=parent_task.plan_id,
        position=next_task_position(session, parent_task.plan_id),
        task_type=task_type,
        title=title,
        instructions=instructions,
        status=initial_status,
        input_payload=input_payload or {},
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    session.add(child_task)
    session.flush()

    dependency = None
    if create_dependency:
        dependency = TaskDependency(
            task_id=child_task.id,
            depends_on_task_id=parent_task.id,
            dependency_type=dependency_type,
        )
        session.add(dependency)

    relationship = TaskRelationship(
        parent_task_id=parent_task.id,
        child_task_id=child_task.id,
        relationship_type=relation_type,
        relationship_metadata=relationship_metadata,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    session.add(relationship)
    session.flush()
    return child_task, relationship, dependency, True


def create_follow_up_task(
    session: Session,
    task_context: TaskContext,
    request: FollowUpTaskCreateRequest,
    *,
    default_reason: str,
    default_input_payload: Optional[Dict[str, Any]] = None,
) -> Tuple[Task, TaskRelationship, Optional[TaskDependency], bool]:
    acceptance_criteria = request.acceptance_criteria or extract_acceptance_criteria(
        task_context.task,
        task_context.requirements,
    )
    constraints = request.constraints or extract_constraints(task_context.task)
    input_payload = {
        **(default_input_payload or {}),
        "parent_task_id": str(task_context.task.id),
        "follow_up_reason": request.reason or default_reason,
        "acceptance_criteria": acceptance_criteria,
        "constraints": constraints,
    }
    title = request.title or f"Follow-up: {task_context.task.title}"
    instructions = request.instructions or (
        f"Continue work from task '{task_context.task.title}'. "
        f"Reason: {request.reason or default_reason}. "
        "Preserve prior constraints and focus only on the unresolved scope."
    )
    return create_linked_task(
        session,
        parent_task=task_context.task,
        relation_type=request.relation_type,
        title=title,
        instructions=instructions,
        task_type=request.task_type,
        input_payload=input_payload,
        create_dependency=False,
        relationship_metadata={
            "reason": request.reason or default_reason,
            "push_to_jira": request.push_to_jira,
            "idempotency_key": f"{task_context.task.id}:{request.relation_type}:{title}",
        },
        initial_status="pending",
    )


def create_follow_up_task_from_evaluation(
    session: Session,
    task_context: TaskContext,
    result_evaluation: ResultEvaluationRead,
    *,
    triage_category: str,
    triage_summary: str,
) -> Tuple[Task, TaskRelationship, Optional[TaskDependency], bool]:
    unresolved_scope = [
        *result_evaluation.reviewer_decision.unmet_acceptance_criteria,
        *result_evaluation.qa_decision.missing_checks,
    ]
    request = FollowUpTaskCreateRequest(
        title=f"Rework: {task_context.task.title}",
        instructions=(
            f"Address the unresolved work discovered after result evaluation for '{task_context.task.title}'. "
            f"Triage category: {triage_category}. "
            f"Reviewer findings: {', '.join(result_evaluation.reviewer_decision.unmet_acceptance_criteria[:3]) or 'none recorded'}. "
            f"QA findings: {', '.join(result_evaluation.qa_decision.missing_checks[:3]) or 'none recorded'}."
        ),
        task_type="follow_up",
        reason=triage_summary,
        acceptance_criteria=unresolved_scope,
        relation_type="follow_up",
    )
    return create_follow_up_task(
        session,
        task_context,
        request,
        default_reason=triage_summary,
        default_input_payload={
            "source_run_id": str(result_evaluation.run_id),
            "result_status": result_evaluation.status,
            "follow_up_actions": result_evaluation.follow_up_actions,
        },
    )


def create_result_chain_task(
    session: Session,
    task_context: TaskContext,
    result_evaluation: ResultEvaluationRead,
) -> Optional[Tuple[Task, TaskRelationship, Optional[TaskDependency], bool]]:
    if result_evaluation.status != "passed":
        return None

    existing_chain = get_task_relationships(
        session,
        parent_task_id=task_context.task.id,
        relationship_type="chain",
    )
    if existing_chain:
        child_task = session.get(Task, existing_chain[0].child_task_id)
        dependency = session.exec(
            select(TaskDependency).where(
                TaskDependency.task_id == existing_chain[0].child_task_id,
                TaskDependency.depends_on_task_id == task_context.task.id,
            )
        ).first()
        if child_task:
            return child_task, existing_chain[0], dependency, False

    next_task_type = None
    lowered_title = task_context.task.title.lower()
    if task_context.task.task_type in {"generic", "implementation", "feature"} or "implement" in lowered_title:
        next_task_type = "verification"
    elif task_context.task.task_type == "verification":
        next_task_type = "refactor"
    elif task_context.task.task_type == "refactor":
        next_task_type = "optimize"

    if not next_task_type:
        return None

    title = f"{next_task_type.replace('_', ' ').title()}: {task_context.task.title}"
    instructions = (
        f"Execute the next chained task after '{task_context.task.title}'. "
        f"This task was created automatically because the parent task finished with status '{result_evaluation.status}'."
    )
    input_payload = {
        "parent_task_id": str(task_context.task.id),
        "chain_source_run_id": str(result_evaluation.run_id),
        "chain_source_status": result_evaluation.status,
        "acceptance_criteria": extract_acceptance_criteria(task_context.task, task_context.requirements),
        "constraints": extract_constraints(task_context.task),
    }
    return create_linked_task(
        session,
        parent_task=task_context.task,
        relation_type="chain",
        title=title,
        instructions=instructions,
        task_type=next_task_type,
        input_payload=input_payload,
        create_dependency=True,
        dependency_type="blocks",
        relationship_metadata={
            "source_status": result_evaluation.status,
            "idempotency_key": f"{task_context.task.id}:chain:{next_task_type}",
        },
        initial_status="pending",
    )


def activate_dependency_chain(session: Session, task_id) -> List[Task]:
    downstream_links = session.exec(
        select(TaskDependency).where(TaskDependency.depends_on_task_id == task_id)
    ).all()
    ready_tasks: List[Task] = []
    for link in downstream_links:
        candidate = session.get(Task, link.task_id)
        if not candidate or candidate.status in {"completed", "done", "approved", "escalated"}:
            continue
        dependencies = session.exec(
            select(TaskDependency).where(TaskDependency.task_id == candidate.id)
        ).all()
        dependency_tasks = [session.get(Task, dependency.depends_on_task_id) for dependency in dependencies]
        if all(task and is_dependency_satisfied(task.status) for task in dependency_tasks):
            candidate.status = "ready_for_dispatch"
            candidate.updated_at = datetime.now(timezone.utc)
            session.add(candidate)
            ready_tasks.append(candidate)
    return ready_tasks
