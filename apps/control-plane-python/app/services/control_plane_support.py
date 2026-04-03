from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import re
from typing import Any, Dict, Iterable, List, Optional, Sequence

from sqlalchemy import or_
from sqlmodel import Session, select

from ..models import (
    Approval,
    Event,
    ExecutionRun,
    Plan,
    Project,
    ProjectRequirement,
    Task,
    TaskDependency,
    TaskSession,
)

ACCEPTANCE_KEYS = (
    "acceptance_criteria",
    "acceptanceCriteria",
    "success_criteria",
    "successCriteria",
    "done_definition",
    "definition_of_done",
    "deliverables",
    "validation_checks",
    "qa_checks",
    "tests",
)

CONSTRAINT_KEYS = (
    "constraints",
    "guardrails",
    "limits",
    "allowed_paths",
    "forbidden_paths",
    "scope",
    "protected_paths",
    "touch_points",
)

CHANGED_FILE_KEYS = (
    "changed_files",
    "files_changed",
    "modified_files",
    "touched_files",
    "paths",
    "artifacts",
)

SUCCESS_STATUSES = {"completed", "complete", "succeeded", "success", "passed", "done", "approved"}
FAILURE_STATUSES = {"failed", "error", "errored", "cancelled", "canceled", "blocked", "timeout"}
BLOCKED_TERMS = {"blocked", "dependency", "dependencies", "approval", "missing", "unavailable", "waiting"}
HIGH_RISK_TASK_TYPES = {"verification", "migration", "database", "infra", "security", "deployment"}
HIGH_RISK_KEYWORDS = {
    "schema",
    "migration",
    "database",
    "auth",
    "permission",
    "credential",
    "secret",
    "production",
    "deploy",
    "infra",
    "delete",
    "drop",
    "billing",
}
REGRESSION_PRONE_PATH_TERMS = {"auth", "routing", "db", "schema", "config", "permission", "policy"}
STOPWORDS = {
    "the",
    "and",
    "with",
    "that",
    "this",
    "from",
    "into",
    "then",
    "than",
    "must",
    "should",
    "will",
    "have",
    "your",
    "task",
    "user",
    "need",
    "needs",
}


@dataclass
class DependencyContext:
    link: TaskDependency
    task: Task


@dataclass
class TaskContext:
    project: Project
    plan: Plan
    task: Task
    requirements: List[ProjectRequirement]
    approvals: List[Approval]
    dependencies: List[DependencyContext]
    task_sessions: List[TaskSession]
    execution_runs: List[ExecutionRun]
    events: List[Event]
    latest_task_memory: Optional[Event] = None
    latest_project_memory: Optional[Event] = None


@dataclass
class RunContext:
    task_context: TaskContext
    task_session: TaskSession
    execution_run: ExecutionRun
    session_events: List[Event] = field(default_factory=list)
    run_events: List[Event] = field(default_factory=list)


def unique_list(items: Iterable[str]) -> List[str]:
    seen = set()
    results: List[str] = []
    for item in items:
        normalized = normalize_whitespace(item)
        if not normalized:
            continue
        key = normalized.lower()
        if key in seen:
            continue
        seen.add(key)
        results.append(normalized)
    return results


def normalize_whitespace(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "memory"


def flatten_text_fragments(value: Any) -> List[str]:
    fragments: List[str] = []
    if value is None:
        return fragments
    if isinstance(value, str):
        normalized = normalize_whitespace(value)
        if normalized:
            fragments.append(normalized)
        return fragments
    if isinstance(value, (int, float, bool)):
        return [str(value)]
    if isinstance(value, dict):
        for key, item in value.items():
            fragments.extend(flatten_text_fragments(key))
            fragments.extend(flatten_text_fragments(item))
        return fragments
    if isinstance(value, (list, tuple, set)):
        for item in value:
            fragments.extend(flatten_text_fragments(item))
        return fragments
    return [normalize_whitespace(str(value))]


def payload_string_list(payload: Dict[str, Any], candidate_keys: Sequence[str]) -> List[str]:
    matches: List[str] = []
    for key in candidate_keys:
        if key in payload:
            matches.extend(flatten_text_fragments(payload.get(key)))
    return unique_list(matches)


def bullet_lines(text: str) -> List[str]:
    lines = []
    for raw_line in (text or "").splitlines():
        line = raw_line.strip(" -*\t")
        if not line:
            continue
        if raw_line.strip().startswith(("-", "*")) or re.match(r"^\d+[\.\)]", raw_line.strip()):
            lines.append(line)
    return unique_list(lines)


def extract_acceptance_criteria(task: Task, requirements: Optional[Sequence[ProjectRequirement]] = None) -> List[str]:
    criteria = payload_string_list(task.input_payload, ACCEPTANCE_KEYS)
    if not criteria:
        criteria.extend(
            line
            for line in bullet_lines(task.instructions)
            if any(token in line.lower() for token in ("must", "should", "ensure", "validate", "test", "accept"))
        )
    if not criteria and task.instructions:
        criteria.append(task.instructions)
    if requirements and task.task_type == "verification":
        criteria.extend(req.requirement_text for req in requirements[:5])
    return unique_list(criteria)


def extract_constraints(task: Task, memory_entries: Optional[Sequence[Dict[str, Any]]] = None) -> List[str]:
    constraints = payload_string_list(task.input_payload, CONSTRAINT_KEYS)
    if task.instructions:
        for line in task.instructions.splitlines():
            normalized = normalize_whitespace(line)
            lowered = normalized.lower()
            if any(token in lowered for token in ("must not", "do not", "only", "cannot", "within", "preserve")):
                constraints.append(normalized)
    for entry in memory_entries or []:
        constraints.extend(flatten_text_fragments(entry.get("constraints")))
    return unique_list(constraints)


def extract_memory_entries(event_payload: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not event_payload:
        return []
    entries = event_payload.get("entries") or []
    if isinstance(entries, list):
        return [entry for entry in entries if isinstance(entry, dict)]
    return []


def extract_changed_files(payload: Dict[str, Any]) -> List[str]:
    candidates: List[str] = []
    for key in CHANGED_FILE_KEYS:
        if key not in payload:
            continue
        value = payload.get(key)
        if isinstance(value, list):
            for item in value:
                if isinstance(item, str):
                    candidates.append(item)
                elif isinstance(item, dict):
                    candidates.extend(
                        str(item.get(field))
                        for field in ("path", "file", "name")
                        if item.get(field)
                    )
        elif isinstance(value, dict):
            candidates.extend(
                str(value.get(field))
                for field in ("path", "file", "name")
                if value.get(field)
            )
        elif isinstance(value, str):
            candidates.append(value)
    return unique_list(candidates)


def read_artifact_excerpt(artifact_path: Optional[str], max_chars: int = 12000) -> str:
    if not artifact_path:
        return ""
    path = Path(artifact_path)
    if not path.is_absolute():
        path = (Path.cwd() / path).resolve()
    if not path.exists() or not path.is_file():
        return ""
    try:
        return path.read_text(encoding="utf-8", errors="ignore")[:max_chars]
    except OSError:
        return ""


def collect_output_evidence(run: ExecutionRun, task_session: TaskSession, events: Sequence[Event]) -> str:
    fragments = flatten_text_fragments(run.output_payload)
    fragments.extend(flatten_text_fragments(task_session.session_metadata))
    if run.error_message:
        fragments.append(run.error_message)
    if run.artifact_path:
        fragments.append(read_artifact_excerpt(run.artifact_path))
    if task_session.artifact_path:
        fragments.append(read_artifact_excerpt(task_session.artifact_path))
    for event in events:
        fragments.extend(flatten_text_fragments(event.payload))
        if event.artifact_path:
            fragments.append(read_artifact_excerpt(event.artifact_path, max_chars=4000))
    return normalize_whitespace(" ".join(fragment for fragment in fragments if fragment))


def extract_keywords(text: str) -> List[str]:
    words = re.findall(r"[a-zA-Z0-9_/.-]{4,}", text.lower())
    return [word for word in words if word not in STOPWORDS]


def criterion_has_evidence(criterion: str, evidence_text: str) -> bool:
    criterion_keywords = unique_list(extract_keywords(criterion))[:4]
    lowered_evidence = evidence_text.lower()
    if not criterion_keywords:
        return False
    hits = sum(1 for keyword in criterion_keywords if keyword in lowered_evidence)
    return hits >= min(2, len(criterion_keywords))


def derive_allowed_paths(constraints: Sequence[str]) -> List[str]:
    paths: List[str] = []
    for constraint in constraints:
        matches = re.findall(r"(?:[A-Za-z]:\\|/)?[\w.\-\\/]+(?:/[\w.\-\\/]+)+", constraint)
        paths.extend(match.replace("\\", "/").strip("/") for match in matches)
    return unique_list(paths)


def previous_failure_count(execution_runs: Sequence[ExecutionRun]) -> int:
    failures = 0
    for run in execution_runs:
        status = (run.status or "").lower()
        if status in FAILURE_STATUSES or run.error_message:
            failures += 1
    return failures


def infer_risk_level(risk_flags: Sequence[str], failure_count: int) -> str:
    score = len(set(risk_flags))
    if failure_count >= 2:
        score += 2
    if score >= 5:
        return "high"
    if score >= 2:
        return "medium"
    return "low"


def is_success_status(status: Optional[str]) -> bool:
    return (status or "").lower() in SUCCESS_STATUSES


def is_failure_status(status: Optional[str]) -> bool:
    return (status or "").lower() in FAILURE_STATUSES


def is_blocked_error(error_message: Optional[str]) -> bool:
    lowered = (error_message or "").lower()
    return any(marker in lowered for marker in BLOCKED_TERMS)


def latest_memory_event(session: Session, *, project_id=None, task_id=None, event_type: str) -> Optional[Event]:
    statement = select(Event).where(Event.event_type == event_type)
    if project_id is not None:
        statement = statement.where(Event.project_id == project_id)
    if task_id is not None:
        statement = statement.where(Event.task_id == task_id)
    return session.exec(statement.order_by(Event.occurred_at.desc())).first()


def get_task_context(session: Session, task_id) -> TaskContext:
    task = session.get(Task, task_id)
    if not task:
        raise LookupError("Task not found")

    plan = session.get(Plan, task.plan_id)
    if not plan:
        raise LookupError("Plan not found for task")

    project = session.get(Project, plan.project_id)
    if not project:
        raise LookupError("Project not found for task")

    requirements = session.exec(
        select(ProjectRequirement)
        .where(ProjectRequirement.project_id == project.id)
        .order_by(ProjectRequirement.position)
    ).all()

    approvals = session.exec(
        select(Approval).where(Approval.plan_id == plan.id).order_by(Approval.requested_at.desc())
    ).all()

    dependency_links = session.exec(
        select(TaskDependency).where(TaskDependency.task_id == task.id)
    ).all()
    dependencies: List[DependencyContext] = []
    for link in dependency_links:
        dependency_task = session.get(Task, link.depends_on_task_id)
        if dependency_task:
            dependencies.append(DependencyContext(link=link, task=dependency_task))

    task_sessions = session.exec(
        select(TaskSession).where(TaskSession.task_id == task.id).order_by(TaskSession.started_at.desc())
    ).all()
    session_ids = [task_session.id for task_session in task_sessions]

    execution_runs: List[ExecutionRun] = []
    if session_ids:
        execution_runs = session.exec(
            select(ExecutionRun)
            .where(ExecutionRun.task_session_id.in_(session_ids))
            .order_by(ExecutionRun.created_at.desc())
        ).all()

    event_filters = [Event.task_id == task.id, Event.plan_id == plan.id]
    if session_ids:
        event_filters.append(Event.task_session_id.in_(session_ids))
    run_ids = [execution_run.id for execution_run in execution_runs]
    if run_ids:
        event_filters.append(Event.execution_run_id.in_(run_ids))

    events = session.exec(
        select(Event)
        .where(or_(*event_filters))
        .order_by(Event.occurred_at.desc())
    ).all()

    return TaskContext(
        project=project,
        plan=plan,
        task=task,
        requirements=requirements,
        approvals=approvals,
        dependencies=dependencies,
        task_sessions=task_sessions,
        execution_runs=execution_runs,
        events=events,
        latest_task_memory=latest_memory_event(
            session,
            task_id=task.id,
            event_type="memory.task_summary_curated",
        ),
        latest_project_memory=latest_memory_event(
            session,
            project_id=project.id,
            event_type="memory.project_canonical_curated",
        ),
    )


def get_run_context(session: Session, run_id) -> RunContext:
    execution_run = session.get(ExecutionRun, run_id)
    if not execution_run:
        raise LookupError("Execution run not found")

    task_session = session.get(TaskSession, execution_run.task_session_id)
    if not task_session:
        raise LookupError("Task session not found for run")

    task_context = get_task_context(session, task_session.task_id)
    session_events = [event for event in task_context.events if event.task_session_id == task_session.id]
    run_events = [event for event in task_context.events if event.execution_run_id == execution_run.id]
    return RunContext(
        task_context=task_context,
        task_session=task_session,
        execution_run=execution_run,
        session_events=session_events,
        run_events=run_events,
    )


def create_event(
    session: Session,
    *,
    event_source: str,
    event_type: str,
    payload: Dict[str, Any],
    project_id=None,
    plan_id=None,
    task_id=None,
    task_session_id=None,
    execution_run_id=None,
    artifact_path: Optional[str] = None,
) -> Event:
    event = Event(
        project_id=project_id,
        plan_id=plan_id,
        task_id=task_id,
        task_session_id=task_session_id,
        execution_run_id=execution_run_id,
        event_source=event_source,
        event_type=event_type,
        artifact_path=artifact_path,
        payload=payload,
    )
    session.add(event)
    return event
