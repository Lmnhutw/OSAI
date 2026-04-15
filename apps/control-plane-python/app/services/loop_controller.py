from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlmodel import Session

from ..models import TaskLoopHistory
from ..schemas import LoopDecisionRead, ResultEvaluationRead, TaskLoopStateRead
from .bug_triage_agent import triage_run_failure
from .control_plane_support import (
    create_event,
    get_run_context,
    get_task_context,
    get_task_loop_history,
    latest_result_event,
    record_autonomy_decision,
    unique_list,
)
from .failure_patterns import detect_failure_patterns
from .policy_engine import DEFAULT_LOOP_TIMEOUT_SECONDS, evaluate_loop_policy
from .retry_manager import get_or_create_task_loop_state, schedule_retry
from .task_chainer import (
    activate_dependency_chain,
    create_follow_up_task_from_evaluation,
    create_result_chain_task,
)


def _load_result_evaluation(
    session: Session,
    task_id,
    *,
    run_id=None,
) -> ResultEvaluationRead:
    result_event = latest_result_event(session, task_id=task_id, run_id=run_id)
    if not result_event:
        raise LookupError("No result evaluation exists for this task")
    return ResultEvaluationRead.model_validate(result_event.payload)


def _existing_loop_decision(session: Session, task_id, run_id) -> Optional[LoopDecisionRead]:
    for history_entry in get_task_loop_history(session, task_id):
        if history_entry.execution_run_id != run_id:
            continue
        loop_decision_payload = (history_entry.payload or {}).get("loop_decision")
        if loop_decision_payload:
            return LoopDecisionRead.model_validate(loop_decision_payload)
    return None


def advance_execution_loop(
    session: Session,
    task_id,
    *,
    result_evaluation: Optional[ResultEvaluationRead] = None,
    run_id=None,
) -> LoopDecisionRead:
    result_evaluation = result_evaluation or _load_result_evaluation(session, task_id, run_id=run_id)
    existing_decision = _existing_loop_decision(session, task_id, result_evaluation.run_id)
    if existing_decision:
        return existing_decision

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

    create_event(
        session,
        project_id=task_context.project.id,
        plan_id=task_context.plan.id,
        task_id=task_context.task.id,
        task_session_id=result_evaluation.task_session_id,
        execution_run_id=result_evaluation.run_id,
        event_source="control_plane.bug_triage_agent",
        event_type="bug_triage.recorded",
        payload=bug_triage.model_dump(mode="json"),
    )

    now = datetime.now(timezone.utc)
    loop_state.last_result_status = result_evaluation.status
    loop_state.last_bug_category = bug_triage.category
    loop_state.last_failure_pattern = bug_triage.pattern_key
    loop_state.last_task_session_id = result_evaluation.task_session_id
    loop_state.last_run_id = result_evaluation.run_id
    loop_state.last_transition_at = now
    loop_state.updated_at = now

    next_action = loop_policy.final_action
    decision_status = "escalated"
    requires_human = loop_policy.autonomy_mode != "auto_execute"
    follow_up_task_id = None
    chained_task_ids = []

    if loop_policy.manual_break_required or loop_policy.escalate or result_evaluation.status == "awaiting_review":
        if loop_policy.autonomy_mode == "approval_required":
            decision_status = "awaiting_approval"
            task_context.task.status = "awaiting_approval"
            run_context.task_session.status = "awaiting_approval"
            loop_state.status = "awaiting_approval"
        elif loop_policy.autonomy_mode == "review_required":
            decision_status = "awaiting_review"
            task_context.task.status = "awaiting_review"
            run_context.task_session.status = "awaiting_review"
            loop_state.status = "awaiting_review"
        elif loop_policy.autonomy_mode == "blocked":
            decision_status = "blocked"
            task_context.task.status = "blocked"
            run_context.task_session.status = "blocked"
            loop_state.status = "blocked"
        else:
            decision_status = "escalated"
            task_context.task.status = "escalated"
            run_context.task_session.status = "escalated"
            loop_state.status = "escalated"
        loop_state.current_action = next_action
    elif result_evaluation.status == "passed":
        task_context.task.status = "completed"
        task_context.task.updated_at = now
        run_context.task_session.status = "completed"
        run_context.task_session.updated_at = now
        loop_state.status = "completed"
        loop_state.current_action = "mark_done"
        loop_state.consecutive_failures = 0
        next_action = "mark_done"
        decision_status = "completed"
        requires_human = False

        chain_result = None
        if loop_state.chain_depth < loop_policy.max_chain_depth:
            chain_result = create_result_chain_task(session, task_context, result_evaluation)

        ready_tasks = activate_dependency_chain(session, task_context.task.id)
        if chain_result:
            child_task, _, _, _ = chain_result
            chained_task_ids.append(child_task.id)
        chained_task_ids.extend(task.id for task in ready_tasks if task.id not in chained_task_ids)
        if chained_task_ids:
            next_action = "chain_next_task"
            decision_status = "chain_ready"
            loop_state.status = "chain_ready"
            loop_state.current_action = "chain_next_task"
    elif loop_policy.retry_allowed and bug_triage.recommended_action == "retry":
        retry_response = schedule_retry(
            session,
            task_context,
            loop_state,
            reason=bug_triage.summary,
            policy_decision=loop_policy,
            run_id=result_evaluation.run_id,
        )
        next_action = "re_execute"
        decision_status = retry_response.status
        requires_human = False
        loop_state.status = retry_response.status
        loop_state.current_action = "schedule_retry"
    elif bug_triage.recommended_action == "fix_task" or result_evaluation.status in {"needs_rework", "qa_pending"}:
        follow_up_task, _, _, created = create_follow_up_task_from_evaluation(
            session,
            task_context,
            result_evaluation,
            triage_category=bug_triage.category,
            triage_summary=bug_triage.summary,
        )
        follow_up_task_id = follow_up_task.id
        if created:
            loop_state.follow_up_count += 1
        task_context.task.status = "needs_follow_up"
        task_context.task.updated_at = now
        run_context.task_session.status = "needs_follow_up"
        run_context.task_session.updated_at = now
        loop_state.status = "follow_up_created"
        loop_state.current_action = "create_follow_up_task"
        loop_state.consecutive_failures += 1
        next_action = "create_follow_up_task"
        decision_status = "follow_up_created"
        requires_human = False
    else:
        task_context.task.status = "escalated"
        run_context.task_session.status = "escalated"
        loop_state.status = "escalated"
        loop_state.current_action = "escalate_to_human"

    session.add(task_context.task)
    session.add(run_context.task_session)
    session.add(loop_state)

    loop_decision = LoopDecisionRead(
        task_id=task_context.task.id,
        run_id=result_evaluation.run_id,
        next_action=next_action,
        status=decision_status,
        reasons=unique_list(
            [
                *loop_policy.reason_codes,
                bug_triage.summary,
                *result_evaluation.follow_up_actions,
            ]
        )[:8],
        requires_human=requires_human,
        retry_count=loop_state.retry_count,
        chain_depth=loop_state.chain_depth,
        follow_up_task_id=follow_up_task_id,
        chained_task_ids=chained_task_ids,
        bug_triage=bug_triage,
        failure_patterns=failure_patterns,
        policy_decision=loop_policy,
        loop_state=TaskLoopStateRead.model_validate(loop_state),
        decided_at=now,
    )

    history_entry = TaskLoopHistory(
        task_loop_id=loop_state.id,
        task_id=task_context.task.id,
        task_session_id=result_evaluation.task_session_id,
        execution_run_id=result_evaluation.run_id,
        action=next_action,
        task_status=task_context.task.status,
        result_status=result_evaluation.status,
        bug_category=bug_triage.category,
        failure_pattern_key=bug_triage.pattern_key,
        retry_count=loop_state.retry_count,
        chain_depth=loop_state.chain_depth,
        summary=f"Loop controller selected '{next_action}' after result status '{result_evaluation.status}'.",
        payload={
            "bug_triage": bug_triage.model_dump(mode="json"),
            "failure_patterns": [pattern.model_dump(mode="json") for pattern in failure_patterns],
            "policy_decision": loop_policy.model_dump(mode="json"),
            "loop_decision": loop_decision.model_dump(mode="json"),
        },
        created_at=now,
    )
    session.add(history_entry)

    create_event(
        session,
        project_id=task_context.project.id,
        plan_id=task_context.plan.id,
        task_id=task_context.task.id,
        task_session_id=result_evaluation.task_session_id,
        execution_run_id=result_evaluation.run_id,
        event_source="control_plane.loop_controller",
        event_type="loop.decision_recorded",
        payload=loop_decision.model_dump(mode="json"),
    )
    create_event(
        session,
        project_id=task_context.project.id,
        plan_id=task_context.plan.id,
        task_id=task_context.task.id,
        task_session_id=result_evaluation.task_session_id,
        execution_run_id=result_evaluation.run_id,
        event_source="control_plane.policy_engine",
        event_type="policy.loop_decision",
        payload={
            "task_id": str(task_context.task.id),
            "run_id": str(result_evaluation.run_id),
            "status": decision_status,
            "decision": loop_policy.model_dump(mode="json"),
        },
    )
    record_autonomy_decision(
        session,
        task_context=task_context,
        stage="loop",
        policy_decision=loop_policy,
        task_status=decision_status,
        run_id=result_evaluation.run_id,
        task_session_id=result_evaluation.task_session_id,
    )
    if follow_up_task_id:
        create_event(
            session,
            project_id=task_context.project.id,
            plan_id=task_context.plan.id,
            task_id=task_context.task.id,
            task_session_id=result_evaluation.task_session_id,
            execution_run_id=result_evaluation.run_id,
            event_source="control_plane.loop_controller",
            event_type="task.follow_up_created",
            payload={
                "task_id": str(task_context.task.id),
                "follow_up_task_id": str(follow_up_task_id),
                "source_run_id": str(result_evaluation.run_id),
            },
        )
    if chained_task_ids:
        create_event(
            session,
            project_id=task_context.project.id,
            plan_id=task_context.plan.id,
            task_id=task_context.task.id,
            task_session_id=result_evaluation.task_session_id,
            execution_run_id=result_evaluation.run_id,
            event_source="control_plane.loop_controller",
            event_type="task.chain_advanced",
            payload={
                "task_id": str(task_context.task.id),
                "chained_task_ids": [str(task_id) for task_id in chained_task_ids],
                "source_run_id": str(result_evaluation.run_id),
            },
        )

    return loop_decision
