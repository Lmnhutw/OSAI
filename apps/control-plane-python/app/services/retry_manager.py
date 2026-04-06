from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlmodel import Session

from ..models import TaskLoop
from ..schemas import PolicyDecisionRead, RetryResponse
from .control_plane_support import (
    TaskContext,
    create_event,
    get_task_loop,
    get_task_relationships,
)
from .dispatch_evaluator import evaluate_task_dispatch


def _infer_initial_chain_depth(session: Session, task_id) -> int:
    incoming_relationships = get_task_relationships(session, child_task_id=task_id)
    if not incoming_relationships:
        return 0
    parent_relationship = incoming_relationships[0]
    parent_loop = get_task_loop(session, parent_relationship.parent_task_id)
    if not parent_loop:
        return 1
    return parent_loop.chain_depth + 1


def get_or_create_task_loop_state(
    session: Session,
    task_context: TaskContext,
    *,
    loop_timeout_seconds: int,
) -> TaskLoop:
    loop_state = get_task_loop(session, task_context.task.id)
    if loop_state:
        if not loop_state.timeout_at:
            loop_state.timeout_at = loop_state.loop_started_at + timedelta(seconds=loop_timeout_seconds)
            loop_state.updated_at = datetime.now(timezone.utc)
            session.add(loop_state)
        return loop_state

    now = datetime.now(timezone.utc)
    loop_state = TaskLoop(
        task_id=task_context.task.id,
        status=task_context.task.status or "idle",
        current_action="idle",
        retry_count=0,
        consecutive_failures=0,
        chain_depth=_infer_initial_chain_depth(session, task_context.task.id),
        follow_up_count=0,
        loop_started_at=now,
        last_transition_at=now,
        timeout_at=now + timedelta(seconds=loop_timeout_seconds),
        created_at=now,
        updated_at=now,
    )
    session.add(loop_state)
    session.flush()
    return loop_state


def schedule_retry(
    session: Session,
    task_context: TaskContext,
    loop_state: TaskLoop,
    *,
    reason: str,
    policy_decision: PolicyDecisionRead,
    run_id=None,
) -> RetryResponse:
    if loop_state.retry_count >= policy_decision.max_retry:
        raise ValueError("Retry budget exceeded for task loop")

    loop_state.retry_count += 1
    loop_state.consecutive_failures += 1
    loop_state.status = "retry_scheduled"
    loop_state.current_action = "re_execute"
    loop_state.last_transition_at = datetime.now(timezone.utc)
    loop_state.updated_at = datetime.now(timezone.utc)
    session.add(loop_state)

    task_context.task.status = "retry_scheduled"
    task_context.task.updated_at = datetime.now(timezone.utc)
    session.add(task_context.task)

    create_event(
        session,
        project_id=task_context.project.id,
        plan_id=task_context.plan.id,
        task_id=task_context.task.id,
        execution_run_id=run_id,
        event_source="control_plane.retry_manager",
        event_type="loop.retry_scheduled",
        payload={
            "task_id": str(task_context.task.id),
            "retry_count": loop_state.retry_count,
            "reason": reason,
        },
    )

    dispatch_evaluation = evaluate_task_dispatch(session, task_context.task.id, commit=False)
    next_attempt_no = max((run.attempt_no for run in task_context.execution_runs), default=0) + 1
    return RetryResponse(
        task_id=task_context.task.id,
        status=dispatch_evaluation.status,
        retry_count=loop_state.retry_count,
        next_attempt_no=next_attempt_no,
        reason=reason,
        dispatch_evaluation=dispatch_evaluation,
        scheduled_at=datetime.now(timezone.utc),
    )
