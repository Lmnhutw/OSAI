from datetime import datetime, timezone
from typing import List

from sqlmodel import Session

from ..schemas import ResultEvaluationRead
from .control_plane_support import (
    create_event,
    get_run_context,
    is_blocked_error,
    is_failure_status,
    previous_failure_count,
)
from .policy_engine import evaluate_result_policy
from .qa_agent import run_lightweight_qa
from .reviewer_agent import review_execution_output


def evaluate_run_result(session: Session, run_id) -> ResultEvaluationRead:
    run_context = get_run_context(session, run_id)
    reviewer_decision = review_execution_output(run_context)
    qa_decision = run_lightweight_qa(run_context, reviewer_decision)

    risk_flags: List[str] = []
    if reviewer_decision.scope_deviation:
        risk_flags.append("scope_deviation")
    if reviewer_decision.risky_changes:
        risk_flags.append("risky_changes_detected")
    if qa_decision.missing_checks:
        risk_flags.append("missing_validation_evidence")
    if qa_decision.potential_regressions:
        risk_flags.append("potential_regressions")

    failures = previous_failure_count(run_context.task_context.execution_runs)
    if failures >= 2:
        risk_flags.append("repeated_failure_pattern")

    result_status = "qa_pending"
    run_error = run_context.execution_run.error_message
    if run_context.execution_run.status == "blocked" or is_blocked_error(run_error):
        result_status = "blocked"
        risk_flags.append("run_blocked")
    elif is_failure_status(run_context.execution_run.status) or run_error:
        result_status = "needs_rework"
        risk_flags.append("execution_failure")
    elif reviewer_decision.status == "needs_rework":
        result_status = "needs_rework"
    elif reviewer_decision.status == "review_required":
        result_status = "awaiting_review"
    elif qa_decision.status == "qa_pending":
        result_status = "qa_pending"

    policy_decision = evaluate_result_policy(
        run_context,
        risk_flags=risk_flags,
        result_status=result_status,
        reviewer_decision=reviewer_decision,
        qa_decision=qa_decision,
    )

    follow_up_actions: List[str] = []
    if result_status == "blocked":
        follow_up_actions.extend(
            [
                "Inspect stored worker error details and artifact logs for the blocking dependency or missing input.",
                "Preserve the current execution payload and wait for missing context before retrying.",
            ]
        )
    elif result_status == "needs_rework":
        follow_up_actions.extend(
            [
                "Generate a narrowed rework task that carries forward unmet acceptance criteria.",
                "Attach reviewer and QA findings so the next run focuses on the failing scope only.",
            ]
        )
    elif result_status == "awaiting_review":
        follow_up_actions.append("Route this run through reviewer approval before marking it ready for QA or completion.")
    elif result_status == "qa_pending":
        follow_up_actions.append("Run the lightweight QA checklist against uncovered acceptance criteria and regression-prone files.")

    if policy_decision.require_approval:
        follow_up_actions.append("Request approval before retrying or finalizing the run result.")
    if policy_decision.escalate:
        follow_up_actions.append("Escalate to an operator because the retry budget or risk profile has been exceeded.")

    evaluation = ResultEvaluationRead(
        run_id=run_context.execution_run.id,
        task_id=run_context.task_context.task.id,
        task_session_id=run_context.task_session.id,
        status=result_status,
        risk_flags=list(dict.fromkeys(risk_flags)),
        follow_up_actions=list(dict.fromkeys(follow_up_actions)),
        reviewer_decision=reviewer_decision,
        qa_decision=qa_decision,
        policy_decision=policy_decision,
        evaluated_at=datetime.now(timezone.utc),
    )

    run_context.task_context.task.status = result_status
    run_context.task_session.status = result_status
    session.add(run_context.task_context.task)
    session.add(run_context.task_session)

    create_event(
        session,
        project_id=run_context.task_context.project.id,
        plan_id=run_context.task_context.plan.id,
        task_id=run_context.task_context.task.id,
        task_session_id=run_context.task_session.id,
        execution_run_id=run_context.execution_run.id,
        event_source="control_plane.reviewer_agent",
        event_type="reviewer.decision_recorded",
        payload=reviewer_decision.model_dump(mode="json"),
    )
    create_event(
        session,
        project_id=run_context.task_context.project.id,
        plan_id=run_context.task_context.plan.id,
        task_id=run_context.task_context.task.id,
        task_session_id=run_context.task_session.id,
        execution_run_id=run_context.execution_run.id,
        event_source="control_plane.qa_agent",
        event_type="qa.decision_recorded",
        payload=qa_decision.model_dump(mode="json"),
    )
    create_event(
        session,
        project_id=run_context.task_context.project.id,
        plan_id=run_context.task_context.plan.id,
        task_id=run_context.task_context.task.id,
        task_session_id=run_context.task_session.id,
        execution_run_id=run_context.execution_run.id,
        event_source="control_plane.result_evaluator",
        event_type="result_evaluation.recorded",
        payload=evaluation.model_dump(mode="json"),
    )
    create_event(
        session,
        project_id=run_context.task_context.project.id,
        plan_id=run_context.task_context.plan.id,
        task_id=run_context.task_context.task.id,
        task_session_id=run_context.task_session.id,
        execution_run_id=run_context.execution_run.id,
        event_source="control_plane.policy_engine",
        event_type="policy.result_decision",
        payload={
            "run_id": str(run_context.execution_run.id),
            "status": result_status,
            "decision": policy_decision.model_dump(mode="json"),
        },
    )
    session.commit()

    return evaluation
