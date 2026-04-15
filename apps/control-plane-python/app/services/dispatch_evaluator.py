from datetime import datetime, timezone
from typing import List

from sqlmodel import Session

from ..schemas import DependencyStatusRead, DispatchEvaluationRead
from .control_plane_support import (
    HIGH_RISK_KEYWORDS,
    HIGH_RISK_TASK_TYPES,
    create_event,
    extract_acceptance_criteria,
    extract_constraints,
    extract_memory_entries,
    infer_risk_level,
    is_dependency_satisfied,
    normalize_whitespace,
    previous_failure_count,
    get_task_context,
    record_autonomy_decision,
)
from .policy_engine import evaluate_dispatch_policy


def evaluate_task_dispatch(session: Session, task_id, *, commit: bool = True) -> DispatchEvaluationRead:
    task_context = get_task_context(session, task_id)
    project_memory_entries = extract_memory_entries(
        task_context.latest_project_memory.payload if task_context.latest_project_memory else None
    )
    task_memory_entries = extract_memory_entries(
        task_context.latest_task_memory.payload if task_context.latest_task_memory else None
    )

    acceptance_criteria = extract_acceptance_criteria(task_context.task, task_context.requirements)
    constraints = extract_constraints(
        task_context.task,
        memory_entries=[*project_memory_entries, *task_memory_entries],
    )

    dependency_statuses: List[DependencyStatusRead] = []
    blocked_dependencies = []
    for dependency in task_context.dependencies:
        dependency_statuses.append(
            DependencyStatusRead(
                task_id=dependency.task.id,
                title=dependency.task.title,
                status=dependency.task.status,
                dependency_type=dependency.link.dependency_type,
            )
        )
        if not is_dependency_satisfied(dependency.task.status):
            blocked_dependencies.append(dependency.task.title)

    missing_context: List[str] = []
    if not acceptance_criteria:
        missing_context.append("Acceptance criteria are missing from the task payload and instructions.")
    elif len(acceptance_criteria) == 1 and not any(
        token in acceptance_criteria[0].lower() for token in ("test", "validate", "accept", "verify")
    ):
        missing_context.append("Acceptance criteria exist, but they do not describe explicit validation evidence.")

    normalized_instructions = normalize_whitespace(task_context.task.instructions)
    if len(normalized_instructions) < 40:
        missing_context.append("Task instructions are too thin to define a safe execution scope.")

    if not constraints:
        missing_context.append("Constraints or guardrails are not captured for this task.")

    if blocked_dependencies:
        missing_context.append(
            "Dependencies are not complete: " + ", ".join(blocked_dependencies)
        )

    risk_flags: List[str] = []
    if not acceptance_criteria:
        risk_flags.append("missing_acceptance_criteria")
    if not constraints:
        risk_flags.append("missing_constraints")
    if len(normalized_instructions) < 40:
        risk_flags.append("unclear_scope")
    if blocked_dependencies:
        risk_flags.append("blocked_dependency")
    if task_context.task.task_type in HIGH_RISK_TASK_TYPES:
        risk_flags.append("high_risk_task_type")

    lowered_scope = f"{task_context.task.title} {task_context.task.instructions}".lower()
    if any(keyword in lowered_scope for keyword in HIGH_RISK_KEYWORDS):
        risk_flags.append("risky_change_surface")

    failures = previous_failure_count(task_context.execution_runs)
    if failures >= 2:
        risk_flags.append("repeated_failure_pattern")

    policy_decision = evaluate_dispatch_policy(
        session,
        task_context,
        risk_flags=risk_flags,
        missing_context=missing_context,
    )

    status = "ready_for_dispatch"
    if missing_context:
        status = "needs_context"
    elif policy_decision.block:
        status = "dispatch_blocked"
    elif policy_decision.require_approval:
        status = "awaiting_approval"
    elif policy_decision.require_review:
        status = "awaiting_review"

    ready_for_execution = status == "ready_for_dispatch" and policy_decision.allow_auto_execute
    risk_level = infer_risk_level(risk_flags, failures)

    execution_payload = {
        "project": {
            "id": str(task_context.project.id),
            "name": task_context.project.name,
        },
        "plan": {
            "id": str(task_context.plan.id),
            "version": task_context.plan.version,
            "status": task_context.plan.status,
        },
        "task": {
            "id": str(task_context.task.id),
            "title": task_context.task.title,
            "task_type": task_context.task.task_type,
            "instructions": task_context.task.instructions,
        },
        "acceptance_criteria": acceptance_criteria,
        "constraints": constraints,
        "dependencies": [dependency.model_dump(mode="json") for dependency in dependency_statuses],
        "prior_failures": failures,
        "memory": {
            "task": task_memory_entries[:5],
            "project": project_memory_entries[:5],
        },
        "policy_hints": {
            "reason_codes": policy_decision.reason_codes,
            "require_review": policy_decision.require_review,
            "require_qa": policy_decision.require_qa,
            "require_approval": policy_decision.require_approval,
        },
    }

    evaluation = DispatchEvaluationRead(
        task_id=task_context.task.id,
        status=status,
        ready_for_execution=ready_for_execution,
        risk_level=risk_level,
        missing_context=missing_context,
        risk_flags=risk_flags,
        acceptance_criteria=acceptance_criteria,
        constraints=constraints,
        dependencies=dependency_statuses,
        execution_payload=execution_payload,
        policy_decision=policy_decision,
        evaluated_at=datetime.now(timezone.utc),
    )

    task_context.task.status = status
    session.add(task_context.task)
    create_event(
        session,
        project_id=task_context.project.id,
        plan_id=task_context.plan.id,
        task_id=task_context.task.id,
        event_source="control_plane.dispatch_evaluator",
        event_type="dispatch_evaluation.recorded",
        payload=evaluation.model_dump(mode="json"),
    )
    create_event(
        session,
        project_id=task_context.project.id,
        plan_id=task_context.plan.id,
        task_id=task_context.task.id,
        event_source="control_plane.policy_engine",
        event_type="policy.dispatch_decision",
        payload={
            "task_id": str(task_context.task.id),
            "status": status,
            "decision": policy_decision.model_dump(mode="json"),
        },
    )
    record_autonomy_decision(
        session,
        task_context=task_context,
        stage="dispatch",
        policy_decision=policy_decision,
        task_status=status,
    )
    if commit:
        session.commit()

    return evaluation
