from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional

from sqlmodel import Session, select

from ..models import AutonomyOverride, Event, ExecutionRun, Plan, Project, Task, TaskSession
from ..schemas import (
    AutonomyEvaluationRequest,
    AutonomyOverrideCreate,
    AutonomyOverrideRead,
    ProjectAutonomySummaryRead,
    ProjectAutonomyTaskSummaryRead,
    TaskAutonomyRead,
)
from .control_plane_support import create_event, get_task_context
from .dispatch_evaluator import evaluate_task_dispatch
from .loop_controller import advance_execution_loop
from .policy_engine import resolve_overrides
from .result_evaluator import evaluate_run_result

AUTONOMY_EVENT_TYPE = "autonomy.decision_recorded"


def _active_overrides(session: Session, *, project_id, task_id) -> List[AutonomyOverrideRead]:
    resolved = resolve_overrides(session, project_id=project_id, task_id=task_id)
    return [AutonomyOverrideRead.model_validate(record) for record in resolved.records]


def _latest_autonomy_event(session: Session, *, task_id, stage: str | None = None) -> Optional[Event]:
    events = session.exec(
        select(Event)
        .where(
            Event.task_id == task_id,
            Event.event_type == AUTONOMY_EVENT_TYPE,
        )
        .order_by(Event.occurred_at.desc())
    ).all()
    if not stage:
        return events[0] if events else None
    for event in events:
        if (event.payload or {}).get("stage") == stage:
            return event
    return None


def _latest_run_id(session: Session, *, task_id):
    run = session.exec(
        select(ExecutionRun)
        .join(TaskSession, ExecutionRun.task_session_id == TaskSession.id)
        .where(TaskSession.task_id == task_id)
        .order_by(ExecutionRun.created_at.desc())
    ).first()
    return run.id if run else None


def get_task_autonomy(session: Session, task_id, *, stage: str | None = None) -> TaskAutonomyRead:
    task_context = get_task_context(session, task_id)
    event = _latest_autonomy_event(session, task_id=task_id, stage=stage)
    if not event:
        raise LookupError("No autonomy decision exists for this task")

    payload = dict(event.payload or {})
    payload["source_event_id"] = event.id
    payload["evaluated_at"] = payload.get("evaluated_at") or event.occurred_at
    payload["active_overrides"] = _active_overrides(
        session,
        project_id=task_context.project.id,
        task_id=task_context.task.id,
    )
    return TaskAutonomyRead.model_validate(payload)


def evaluate_task_autonomy(
    session: Session,
    task_id,
    request: AutonomyEvaluationRequest,
) -> TaskAutonomyRead:
    stage = (request.stage or "dispatch").lower()
    if stage == "dispatch":
        evaluate_task_dispatch(session, task_id, commit=True)
        return get_task_autonomy(session, task_id, stage="dispatch")

    if stage == "result":
        run_id = request.run_id or _latest_run_id(session, task_id=task_id)
        if not run_id:
            raise LookupError("No execution run exists for result autonomy evaluation")
        evaluate_run_result(session, run_id)
        return get_task_autonomy(session, task_id, stage="result")

    if stage == "loop":
        run_id = request.run_id or _latest_run_id(session, task_id=task_id)
        advance_execution_loop(session, task_id, run_id=run_id)
        session.commit()
        return get_task_autonomy(session, task_id, stage="loop")

    raise ValueError("Unsupported autonomy evaluation stage")


def apply_task_autonomy_override(
    session: Session,
    task_id,
    override_in: AutonomyOverrideCreate,
) -> AutonomyOverrideRead:
    task_context = get_task_context(session, task_id)
    override = AutonomyOverride(
        project_id=task_context.project.id,
        task_id=None if override_in.apply_to_project else task_context.task.id,
        scope="project" if override_in.apply_to_project else "task",
        operator=override_in.operator,
        reason=override_in.reason,
        force_autonomy_mode=override_in.force_autonomy_mode,
        force_review=override_in.force_review,
        disable_retries=override_in.disable_retries,
        sensitive_modules=override_in.sensitive_modules,
        policy_adjustments=override_in.policy_adjustments,
    )
    session.add(override)
    session.flush()
    create_event(
        session,
        project_id=task_context.project.id,
        task_id=None if override_in.apply_to_project else task_context.task.id,
        event_source="control_plane.autonomy_policy_engine",
        event_type="autonomy.override_recorded",
        payload={
            "override_id": str(override.id),
            "scope": override.scope,
            "operator": override.operator,
            "reason": override.reason,
            "force_autonomy_mode": override.force_autonomy_mode,
            "force_review": override.force_review,
            "disable_retries": override.disable_retries,
            "sensitive_modules": override.sensitive_modules,
            "policy_adjustments": override.policy_adjustments,
        },
    )
    session.commit()
    session.refresh(override)
    return AutonomyOverrideRead.model_validate(override)


def get_project_autonomy_summary(session: Session, project_id) -> ProjectAutonomySummaryRead:
    project = session.get(Project, project_id)
    if not project:
        raise LookupError("Project not found")

    tasks = session.exec(
        select(Task)
        .join(Plan, Task.plan_id == Plan.id)
        .where(Plan.project_id == project_id)
        .order_by(Task.position.asc())
    ).all()
    events = session.exec(
        select(Event)
        .where(
            Event.project_id == project_id,
            Event.event_type == AUTONOMY_EVENT_TYPE,
        )
        .order_by(Event.occurred_at.desc())
    ).all()

    latest_by_task = {}
    for event in events:
        if event.task_id and event.task_id not in latest_by_task:
            latest_by_task[event.task_id] = event

    mode_counts = {}
    classification_counts = {}
    sensitive_scope_counts = {}
    task_summaries: List[ProjectAutonomyTaskSummaryRead] = []

    for task in tasks:
        event = latest_by_task.get(task.id)
        if not event:
            continue
        payload = event.payload or {}
        decision = payload.get("policy_decision") or {}
        mode = decision.get("autonomy_mode", "unknown")
        mode_counts[mode] = mode_counts.get(mode, 0) + 1
        classification = decision.get("task_classification", "unknown")
        classification_counts[classification] = classification_counts.get(classification, 0) + 1
        for scope in decision.get("sensitive_scope") or []:
            sensitive_scope_counts[scope] = sensitive_scope_counts.get(scope, 0) + 1
        task_summaries.append(
            ProjectAutonomyTaskSummaryRead.model_validate(
                {
                    "task_id": task.id,
                    "title": task.title,
                    "status": task.status,
                    "autonomy_mode": mode,
                    "confidence_score": decision.get("confidence_score", 0.0),
                    "confidence_label": decision.get("confidence_label", "low"),
                    "task_classification": classification,
                    "sensitive_scope": decision.get("sensitive_scope") or [],
                    "final_action": decision.get("final_action", "unknown"),
                    "evaluated_at": payload.get("evaluated_at") or event.occurred_at,
                }
            )
        )

    return ProjectAutonomySummaryRead(
        project_id=project_id,
        total_tasks=len(tasks),
        evaluated_tasks=len(task_summaries),
        unevaluated_tasks=max(0, len(tasks) - len(task_summaries)),
        mode_counts=mode_counts,
        classification_counts=classification_counts,
        sensitive_scope_counts=sensitive_scope_counts,
        tasks=task_summaries,
        generated_at=datetime.now(timezone.utc),
    )
