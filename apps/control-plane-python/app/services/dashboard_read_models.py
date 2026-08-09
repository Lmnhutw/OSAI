"""Read-only aggregates for dashboard pages; no workflow mutations live here."""

from sqlmodel import Session, select

from ..models import Approval, Event, ExecutionRun, Plan, Project, Task, TaskSession
from ..schemas import ProjectOverviewRead, RunInspectionRead, TaskWorkbenchRead


def project_overview(session: Session, project_id) -> ProjectOverviewRead:
    project = session.get(Project, project_id)
    if not project:
        raise LookupError("Project not found")
    plans = session.exec(select(Plan).where(Plan.project_id == project_id).order_by(Plan.version.desc())).all()
    tasks = session.exec(
        select(Task).join(Plan, Task.plan_id == Plan.id).where(Plan.project_id == project_id)
    ).all()
    counts: dict[str, int] = {}
    for task in tasks:
        counts[task.status] = counts.get(task.status, 0) + 1
    pending = session.exec(
        select(Approval).join(Plan, Approval.plan_id == Plan.id).where(Plan.project_id == project_id, Approval.status == "pending")
    ).all()
    events = session.exec(
        select(Event).where(Event.project_id == project_id).order_by(Event.occurred_at.desc()).limit(20)
    ).all()
    return ProjectOverviewRead(
        project=project,
        latest_plan=plans[0] if plans else None,
        task_status_counts=counts,
        pending_approval_count=len(pending),
        recent_events=events,
    )


def task_workbench(session: Session, task_id) -> TaskWorkbenchRead:
    task = session.get(Task, task_id)
    if not task:
        raise LookupError("Task not found")
    plan = session.get(Plan, task.plan_id)
    if not plan:
        raise LookupError("Plan not found")
    sessions = session.exec(
        select(TaskSession).where(TaskSession.task_id == task.id).order_by(TaskSession.started_at.desc())
    ).all()
    runs = session.exec(
        select(ExecutionRun).join(TaskSession, ExecutionRun.task_session_id == TaskSession.id).where(TaskSession.task_id == task.id).order_by(ExecutionRun.created_at.desc())
    ).all()
    events = session.exec(
        select(Event).where(Event.task_id == task.id).order_by(Event.occurred_at.desc()).limit(50)
    ).all()
    return TaskWorkbenchRead(task=task, plan=plan, sessions=sessions, runs=runs, recent_events=events)


def run_inspection(session: Session, run_id) -> RunInspectionRead:
    run = session.get(ExecutionRun, run_id)
    if not run:
        raise LookupError("Run not found")
    task_session = session.get(TaskSession, run.task_session_id)
    if not task_session:
        raise LookupError("Task session not found")
    task = session.get(Task, task_session.task_id)
    if not task:
        raise LookupError("Task not found")
    plan = session.get(Plan, task.plan_id)
    if not plan:
        raise LookupError("Plan not found")
    events = session.exec(
        select(Event).where(Event.execution_run_id == run.id).order_by(Event.occurred_at.desc()).limit(100)
    ).all()
    return RunInspectionRead(run=run, task=task, plan=plan, session=task_session, events=events)
