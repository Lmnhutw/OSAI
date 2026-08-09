from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from sqlmodel import Session, select

from ..ai_models import JiraIssueMapping
from ..models import Plan, Task
from .control_plane_support import create_event

JiraTransport = Callable[[str, Mapping[str, str], bytes | None, float], dict[str, Any]]


class JiraConfigurationError(RuntimeError):
    pass


class JiraSyncError(RuntimeError):
    pass


@dataclass(frozen=True)
class JiraSettings:
    enabled: bool
    auto_create: bool
    base_url: str
    project_key: str
    email: str
    api_token: str
    bearer_token: str
    ready_label: str
    issue_type: str

    @classmethod
    def from_environment(cls, environ: Mapping[str, str] | None = None) -> "JiraSettings":
        source = environ or os.environ
        settings = cls(
            enabled=_as_bool(source.get("OSAI_JIRA_ENABLED")),
            auto_create=_as_bool(source.get("OSAI_JIRA_AUTO_CREATE")),
            base_url=str(source.get("OSAI_JIRA_BASE_URL", "")).strip().rstrip("/"),
            project_key=str(source.get("OSAI_JIRA_PROJECT_KEY", "")).strip(),
            email=str(source.get("OSAI_JIRA_EMAIL", "")).strip(),
            api_token=str(source.get("OSAI_JIRA_API_TOKEN", "")).strip(),
            bearer_token=str(source.get("OSAI_JIRA_BEARER_TOKEN", "")).strip(),
            ready_label=str(source.get("OSAI_JIRA_READY_LABEL", "osai-ready")).strip() or "osai-ready",
            issue_type=str(source.get("OSAI_JIRA_ISSUE_TYPE", "Task")).strip() or "Task",
        )
        if settings.enabled:
            missing = []
            if not settings.base_url:
                missing.append("OSAI_JIRA_BASE_URL")
            if not settings.project_key:
                missing.append("OSAI_JIRA_PROJECT_KEY")
            if not settings.bearer_token and not (settings.email and settings.api_token):
                missing.append("OSAI_JIRA_BEARER_TOKEN or OSAI_JIRA_EMAIL+OSAI_JIRA_API_TOKEN")
            if missing:
                raise JiraConfigurationError("Missing Jira configuration: " + ", ".join(missing))
        return settings


def _as_bool(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _default_transport(url: str, headers: Mapping[str, str], body: bytes | None, timeout: float) -> dict[str, Any]:
    request = Request(url, data=body, headers=dict(headers), method="POST" if body is not None else "GET")
    try:
        with urlopen(request, timeout=timeout) as response:  # noqa: S310 - URL is operator configuration.
            raw = response.read().decode("utf-8")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise JiraSyncError(f"Jira returned HTTP {exc.code}: {detail[:500]}") from exc
    except URLError as exc:
        raise JiraSyncError(f"Jira request failed: {exc.reason}") from exc
    try:
        return json.loads(raw) if raw else {}
    except json.JSONDecodeError as exc:
        raise JiraSyncError("Jira returned invalid JSON") from exc


def _headers(settings: JiraSettings) -> dict[str, str]:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if settings.bearer_token:
        headers["Authorization"] = f"Bearer {settings.bearer_token}"
    else:
        credential = base64.b64encode(f"{settings.email}:{settings.api_token}".encode()).decode()
        headers["Authorization"] = f"Basic {credential}"
    return headers


def _adf_document(text: str) -> dict[str, Any]:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return {
        "type": "doc",
        "version": 1,
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": line}]}
            for line in lines
        ]
        or [{"type": "paragraph", "content": [{"type": "text", "text": "OSAI task"}]}],
    }


def _request_payload(task: Task, plan: Plan, settings: JiraSettings) -> dict[str, Any]:
    label = f"osai-task-{task.id}"
    return {
        "fields": {
            "project": {"key": settings.project_key},
            "summary": task.title,
            "description": _adf_document(
                f"OSAI task {task.id}\nPlan: {plan.title}\n\nInstructions:\n{task.instructions}"
            ),
            "issuetype": {"name": settings.issue_type},
            "labels": ["osai", settings.ready_label, label],
        }
    }


def _find_existing_issue(
    settings: JiraSettings,
    task_id: str,
    transport: JiraTransport,
) -> tuple[str | None, str | None]:
    label = f"osai-task-{task_id}"
    query = urlencode(
        {
            "jql": f'project = "{settings.project_key}" AND labels = "{label}" ORDER BY created DESC',
            "fields": "key",
            "maxResults": "1",
        }
    )
    response = transport(
        f"{settings.base_url}/rest/api/3/search?{query}",
        _headers(settings),
        None,
        30.0,
    )
    issues = response.get("issues") or []
    if not issues:
        return None, None
    key = str(issues[0].get("key") or "").strip()
    return (key or None, f"{settings.base_url}/browse/{quote(key, safe='-')}") if key else (None, None)


def sync_task_to_jira(
    session: Session,
    *,
    task: Task,
    actor: str,
    environ: Mapping[str, str] | None = None,
    transport: JiraTransport | None = None,
) -> JiraIssueMapping:
    """Create or recover a single Jira issue for a task with durable retries."""
    plan = session.get(Plan, task.plan_id)
    if not plan:
        raise LookupError("Plan not found for task")
    if plan.status != "approved":
        raise JiraSyncError("Jira sync requires an approved plan.")

    settings = JiraSettings.from_environment(environ)
    mapping = session.exec(select(JiraIssueMapping).where(JiraIssueMapping.task_id == task.id)).first()
    if mapping and mapping.sync_status == "synchronized":
        return mapping
    if not mapping:
        mapping = JiraIssueMapping(
            task_id=task.id,
            project_id=plan.project_id,
            idempotency_key=f"jira-task:{task.id}",
        )
        session.add(mapping)
    if not settings.enabled:
        mapping.sync_status = "disabled"
        mapping.error_message = "Jira sync is disabled by OSAI_JIRA_ENABLED."
        session.add(mapping)
        session.commit()
        session.refresh(mapping)
        return mapping

    now = _utcnow()
    mapping.sync_status = "pending"
    mapping.error_message = None
    mapping.attempt_count += 1
    mapping.last_attempt_at = now
    mapping.request_payload = _request_payload(task, plan, settings)
    session.add(mapping)
    session.commit()
    session.refresh(mapping)

    client = transport or _default_transport
    try:
        issue_key, issue_url = _find_existing_issue(settings, str(task.id), client)
        if not issue_key:
            response = client(
                f"{settings.base_url}/rest/api/3/issue",
                _headers(settings),
                json.dumps(mapping.request_payload).encode("utf-8"),
                30.0,
            )
            issue_key = str(response.get("key") or "").strip()
            if not issue_key:
                raise JiraSyncError("Jira issue creation returned no issue key.")
            issue_url = str(response.get("self") or f"{settings.base_url}/browse/{quote(issue_key, safe='-')}")
    except Exception as exc:
        mapping.sync_status = "failed"
        mapping.error_message = str(exc)[:2000]
        session.add(mapping)
        create_event(
            session,
            project_id=plan.project_id,
            plan_id=plan.id,
            task_id=task.id,
            event_source="control_plane.jira_sync",
            event_type="integration.jira_sync_failed",
            payload={"mapping_id": str(mapping.id), "actor": actor, "error": mapping.error_message},
        )
        session.commit()
        raise JiraSyncError(mapping.error_message) from exc

    mapping.sync_status = "synchronized"
    mapping.external_issue_key = issue_key
    mapping.external_issue_url = issue_url
    mapping.error_message = None
    mapping.synchronized_at = _utcnow()
    payload = dict(task.input_payload or {})
    payload["jira"] = {"issue_key": issue_key, "url": issue_url, "mapping_id": str(mapping.id)}
    payload["jira_issue_key"] = issue_key
    task.input_payload = payload
    task.updated_at = _utcnow()
    session.add(task)
    session.add(mapping)
    create_event(
        session,
        project_id=plan.project_id,
        plan_id=plan.id,
        task_id=task.id,
        event_source="control_plane.jira_sync",
        event_type="integration.jira_issue_synchronized",
        payload={"mapping_id": str(mapping.id), "issue_key": issue_key, "actor": actor},
    )
    session.commit()
    session.refresh(mapping)
    return mapping


def auto_sync_generated_tasks(session: Session, tasks: list[Task], *, environ: Mapping[str, str] | None = None) -> None:
    settings = JiraSettings.from_environment(environ)
    if not (settings.enabled and settings.auto_create):
        return
    for task in tasks:
        try:
            sync_task_to_jira(session, task=task, actor="agent:project_manager", environ=environ)
        except JiraSyncError:
            # The durable mapping and event retain the error; generating tasks
            # remains successful so an operator can retry from the dashboard.
            continue
