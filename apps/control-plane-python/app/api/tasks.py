from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from typing import List
import uuid

from ..models import Event, ExecutionRun, Task, TaskDependency, TaskLoopHistory, TaskSession
from ..schemas import (
    AutonomyEvaluationRequest,
    AutonomyOverrideCreate,
    AutonomyOverrideRead,
    BatchTaskApprove,
    DispatchEvaluationRead,
    ExecutionRunRead,
    FollowUpTaskCreateRequest,
    FollowUpTaskRead,
    LoopDecisionRead,
    LoopNextRequest,
    ResultEvaluationRead,
    RetryRequest,
    RetryResponse,
    TaskDependencyRead,
    TaskHistoryEventRead,
    TaskHistoryRead,
    TaskLoopHistoryEntryRead,
    TaskLoopStateRead,
    TaskRelationshipRead,
    TaskRead,
    TaskSessionRead,
    TaskAutonomyRead,
)
from ..services.autonomy_service import (
    apply_task_autonomy_override,
    evaluate_task_autonomy,
    get_task_autonomy,
)
from ..database import get_session
from ..services.bug_triage_agent import triage_run_failure
from ..services.control_plane_support import (
    create_event,
    get_run_context,
    get_task_context,
    get_task_loop,
    get_task_loop_history,
    get_task_relationships,
    latest_result_event,
)
from ..services.dispatch_evaluator import evaluate_task_dispatch
from ..services.failure_patterns import detect_failure_patterns
from ..services.loop_controller import advance_execution_loop
from ..services.policy_engine import DEFAULT_LOOP_TIMEOUT_SECONDS, evaluate_loop_policy
from ..services.retry_manager import get_or_create_task_loop_state, schedule_retry
from ..services.task_chainer import create_follow_up_task

router = APIRouter(prefix="/tasks", tags=["tasks"])


def _result_evaluation_or_404(session: Session, task_id: uuid.UUID, run_id=None) -> ResultEvaluationRead:
    result_event = latest_result_event(session, task_id=task_id, run_id=run_id)
    if not result_event:
        raise HTTPException(status_code=404, detail="No result evaluation found for task")
    return ResultEvaluationRead.model_validate(result_event.payload)


def _event_summary(event: Event) -> str:
    payload = event.payload or {}
    if "summary" in payload and payload["summary"]:
        return str(payload["summary"])
    if "status" in payload:
        return f"{event.event_type} -> {payload['status']}"
    if "decision" in payload and isinstance(payload["decision"], dict):
        reason_codes = payload["decision"].get("reason_codes") or []
        if reason_codes:
            return f"{event.event_type} -> {', '.join(reason_codes[:3])}"
    return event.event_type

@router.get("/{task_id}", response_model=TaskRead)
def get_task(task_id: uuid.UUID, session: Session = Depends(get_session)):
    task = session.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task

@router.get("/{task_id}/dependencies", response_model=List[TaskDependencyRead])
def list_task_dependencies(task_id: uuid.UUID, session: Session = Depends(get_session)):
    task = session.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    deps = session.exec(
        select(TaskDependency)
        .where(TaskDependency.task_id == task_id)
        .order_by(TaskDependency.created_at)
    ).all()
    return deps

@router.get("/{task_id}/sessions", response_model=List[TaskSessionRead])
def list_task_sessions(task_id: uuid.UUID, session: Session = Depends(get_session)):
    task = session.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    sessions = session.exec(
        select(TaskSession)
        .where(TaskSession.task_id == task_id)
        .order_by(TaskSession.started_at.desc())
    ).all()
    return sessions

@router.get("/{task_id}/runs", response_model=List[ExecutionRunRead])
def list_task_runs(task_id: uuid.UUID, session: Session = Depends(get_session)):
    task = session.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    runs = session.exec(
        select(ExecutionRun)
        .join(TaskSession, ExecutionRun.task_session_id == TaskSession.id)
        .where(TaskSession.task_id == task_id)
        .order_by(ExecutionRun.created_at.desc())
    ).all()
    return runs

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

@router.post("/{task_id}/evaluate-dispatch", response_model=DispatchEvaluationRead)
def evaluate_dispatch(
    task_id: uuid.UUID,
    session: Session = Depends(get_session)
):
    try:
        return evaluate_task_dispatch(session, task_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{task_id}/loop/next", response_model=LoopDecisionRead)
def loop_next(
    task_id: uuid.UUID,
    loop_in: LoopNextRequest | None = None,
    session: Session = Depends(get_session),
):
    try:
        decision = advance_execution_loop(
            session,
            task_id,
            run_id=loop_in.run_id if loop_in else None,
        )
        session.commit()
        return decision
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{task_id}/retry", response_model=RetryResponse)
def retry_task(
    task_id: uuid.UUID,
    retry_in: RetryRequest | None = None,
    session: Session = Depends(get_session),
):
    result_evaluation = _result_evaluation_or_404(
        session,
        task_id,
        run_id=retry_in.run_id if retry_in else None,
    )
    try:
        task_context = get_task_context(session, task_id)
        run_context = get_run_context(session, result_evaluation.run_id)
        loop_state = get_or_create_task_loop_state(
            session,
            task_context,
            loop_timeout_seconds=(
                result_evaluation.policy_decision.loop_timeout_seconds or DEFAULT_LOOP_TIMEOUT_SECONDS
            ),
        )
        bug_triage = triage_run_failure(run_context, result_evaluation)
        failure_patterns = detect_failure_patterns(session, task_context, result_evaluation, bug_triage)
        loop_policy = evaluate_loop_policy(
            session,
            task_context,
            loop_state=loop_state,
            result_evaluation=result_evaluation,
            bug_triage=bug_triage,
            failure_patterns=failure_patterns,
        )
        if not loop_policy.retry_allowed:
            raise HTTPException(
                status_code=400,
                detail={
                    "message": "Retry is not allowed for this task",
                    "reason_codes": loop_policy.reason_codes,
                },
            )

        retry_response = schedule_retry(
            session,
            task_context,
            loop_state,
            reason=(retry_in.reason if retry_in and retry_in.reason else bug_triage.summary),
            policy_decision=loop_policy,
            run_id=result_evaluation.run_id,
        )
        loop_state.last_result_status = result_evaluation.status
        loop_state.last_bug_category = bug_triage.category
        loop_state.last_failure_pattern = bug_triage.pattern_key
        loop_state.last_task_session_id = result_evaluation.task_session_id
        loop_state.last_run_id = result_evaluation.run_id
        session.add(loop_state)

        history_entry = TaskLoopHistory(
            task_loop_id=loop_state.id,
            task_id=task_context.task.id,
            task_session_id=result_evaluation.task_session_id,
            execution_run_id=result_evaluation.run_id,
            action="manual_retry",
            task_status=task_context.task.status,
            result_status=result_evaluation.status,
            bug_category=bug_triage.category,
            failure_pattern_key=bug_triage.pattern_key,
            retry_count=loop_state.retry_count,
            chain_depth=loop_state.chain_depth,
            summary="Manual retry requested after the latest result evaluation.",
            payload={
                "retry_response": retry_response.model_dump(mode="json"),
                "policy_decision": loop_policy.model_dump(mode="json"),
                "bug_triage": bug_triage.model_dump(mode="json"),
            },
        )
        session.add(history_entry)
        create_event(
            session,
            project_id=task_context.project.id,
            plan_id=task_context.plan.id,
            task_id=task_context.task.id,
            task_session_id=result_evaluation.task_session_id,
            execution_run_id=result_evaluation.run_id,
            event_source="control_plane.retry_manager",
            event_type="loop.manual_retry_requested",
            payload=retry_response.model_dump(mode="json"),
        )
        session.commit()
        return retry_response
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{task_id}/autonomy/evaluate", response_model=TaskAutonomyRead)
def evaluate_autonomy(
    task_id: uuid.UUID,
    request: AutonomyEvaluationRequest | None = None,
    session: Session = Depends(get_session),
):
    try:
        return evaluate_task_autonomy(
            session,
            task_id,
            request or AutonomyEvaluationRequest(),
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{task_id}/autonomy", response_model=TaskAutonomyRead)
def get_autonomy(task_id: uuid.UUID, session: Session = Depends(get_session)):
    try:
        return get_task_autonomy(session, task_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{task_id}/autonomy/override", response_model=AutonomyOverrideRead)
def override_autonomy(
    task_id: uuid.UUID,
    override_in: AutonomyOverrideCreate,
    session: Session = Depends(get_session),
):
    try:
        return apply_task_autonomy_override(session, task_id, override_in)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{task_id}/follow-up", response_model=FollowUpTaskRead)
def create_follow_up(
    task_id: uuid.UUID,
    follow_up_in: FollowUpTaskCreateRequest,
    session: Session = Depends(get_session),
):
    try:
        task_context = get_task_context(session, task_id)
        task, relationship, dependency, _ = create_follow_up_task(
            session,
            task_context,
            follow_up_in,
            default_reason=follow_up_in.reason or "manual_follow_up",
        )
        jira_sync_status = "skipped"
        if follow_up_in.push_to_jira:
            jira_sync_status = "requested_not_configured"
            create_event(
                session,
                project_id=task_context.project.id,
                plan_id=task_context.plan.id,
                task_id=task_context.task.id,
                event_source="control_plane.follow_up_manager",
                event_type="integration.jira_follow_up_requested",
                payload={
                    "parent_task_id": str(task_context.task.id),
                    "follow_up_task_id": str(task.id),
                },
            )
        create_event(
            session,
            project_id=task_context.project.id,
            plan_id=task_context.plan.id,
            task_id=task_context.task.id,
            event_source="control_plane.follow_up_manager",
            event_type="task.follow_up_created",
            payload={
                "parent_task_id": str(task_context.task.id),
                "follow_up_task_id": str(task.id),
                "relationship_type": relationship.relationship_type,
            },
        )
        session.commit()
        session.refresh(task)
        session.refresh(relationship)
        if dependency:
            session.refresh(dependency)
        return FollowUpTaskRead(
            task=task,
            relationship=relationship,
            dependency=dependency,
            jira_sync_status=jira_sync_status,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{task_id}/history", response_model=TaskHistoryRead)
def get_task_history(task_id: uuid.UUID, session: Session = Depends(get_session)):
    task = session.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    relationships = [
        *get_task_relationships(session, parent_task_id=task_id),
        *get_task_relationships(session, child_task_id=task_id),
    ]
    deduped_relationships = list({relationship.id: relationship for relationship in relationships}.values())
    loop_state = get_task_loop(session, task_id)
    loop_history = get_task_loop_history(session, task_id)
    events = session.exec(
        select(Event)
        .where(Event.task_id == task_id)
        .order_by(Event.occurred_at.desc())
    ).all()

    history_events = [
        TaskHistoryEventRead(
            timestamp=event.occurred_at,
            source=event.event_source,
            entry_type=event.event_type,
            summary=_event_summary(event),
            task_status=(event.payload or {}).get("status"),
            task_session_id=event.task_session_id,
            execution_run_id=event.execution_run_id,
            related_task_id=uuid.UUID((event.payload or {}).get("follow_up_task_id"))
            if (event.payload or {}).get("follow_up_task_id")
            else None,
            payload=event.payload or {},
        )
        for event in events
    ]

    return TaskHistoryRead(
        task_id=task_id,
        loop_state=TaskLoopStateRead.model_validate(loop_state) if loop_state else None,
        relationships=[TaskRelationshipRead.model_validate(relationship) for relationship in deduped_relationships],
        loop_history=[TaskLoopHistoryEntryRead.model_validate(entry) for entry in loop_history],
        entries=sorted(history_events, key=lambda entry: entry.timestamp, reverse=True),
    )
