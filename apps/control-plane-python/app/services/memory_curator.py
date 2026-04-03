from collections import defaultdict
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Sequence

from sqlmodel import Session, select

from ..models import Plan, Project, Task, TaskSession
from ..schemas import (
    MemoryCurateRequest,
    MemoryCurateResponse,
    MemoryEntryRead,
    MemoryEvidenceRefRead,
    ProjectMemoryRead,
    TaskMemoryRead,
)
from .control_plane_support import (
    create_event,
    extract_constraints,
    extract_memory_entries,
    get_task_context,
    latest_memory_event,
    previous_failure_count,
    read_artifact_excerpt,
    slugify,
    unique_list,
)


def _evidence_ref(source_type: str, *, ref_id: Optional[str] = None, artifact_path: Optional[str] = None, note: Optional[str] = None) -> MemoryEvidenceRefRead:
    return MemoryEvidenceRefRead(
        source_type=source_type,
        ref_id=ref_id,
        artifact_path=artifact_path,
        note=note,
    )


def _dedupe_entries(entries: Sequence[MemoryEntryRead]) -> List[MemoryEntryRead]:
    merged: Dict[str, MemoryEntryRead] = {}
    for entry in entries:
        existing = merged.get(entry.dedupe_key)
        if not existing:
            merged[entry.dedupe_key] = entry
            continue

        evidence_refs = existing.evidence_refs + entry.evidence_refs
        deduped_refs: Dict[str, MemoryEvidenceRefRead] = {}
        for evidence in evidence_refs:
            evidence_key = "|".join(
                [
                    evidence.source_type,
                    evidence.ref_id or "",
                    evidence.artifact_path or "",
                    evidence.note or "",
                ]
            )
            deduped_refs[evidence_key] = evidence

        merged[entry.dedupe_key] = MemoryEntryRead(
            scope=existing.scope,
            source_type=existing.source_type,
            subject=existing.subject,
            summary=existing.summary,
            evidence_refs=list(deduped_refs.values()),
            constraints=unique_list([*existing.constraints, *entry.constraints]),
            decision_impact=existing.decision_impact,
            confidence=max(existing.confidence, entry.confidence),
            dedupe_key=existing.dedupe_key,
            updated_at=max(filter(None, [existing.updated_at, entry.updated_at]), default=entry.updated_at),
        )
    return list(merged.values())


def _interesting_artifact_lines(text: str) -> List[str]:
    lines: List[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        lowered = line.lower()
        if not line:
            continue
        if any(token in lowered for token in ("decision", "constraint", "error", "failed", "bug", "regression", "approval")):
            lines.append(line)
    return unique_list(lines)[:3]


def _entry(
    *,
    scope: str,
    source_type: str,
    subject: str,
    summary: str,
    evidence_refs: Optional[Sequence[MemoryEvidenceRefRead]] = None,
    constraints: Optional[Sequence[str]] = None,
    decision_impact: str,
    confidence: float,
    dedupe_seed: str,
) -> MemoryEntryRead:
    return MemoryEntryRead(
        scope=scope,
        source_type=source_type,
        subject=subject,
        summary=summary,
        evidence_refs=list(evidence_refs or []),
        constraints=list(constraints or []),
        decision_impact=decision_impact,
        confidence=confidence,
        dedupe_key=slugify(dedupe_seed),
        updated_at=datetime.now(timezone.utc),
    )


def _task_memory_from_event(event, *, task_id, project_id) -> TaskMemoryRead:
    payload = event.payload or {}
    return TaskMemoryRead.model_validate(
        {
            "task_id": task_id,
            "project_id": project_id,
            "summary": payload.get("summary"),
            "entries": payload.get("entries") or [],
            "generated_at": event.occurred_at,
            "source_event_id": event.id,
        }
    )


def _project_memory_from_event(event, *, project_id) -> ProjectMemoryRead:
    payload = event.payload or {}
    return ProjectMemoryRead.model_validate(
        {
            "project_id": project_id,
            "summary": payload.get("summary"),
            "entries": payload.get("entries") or [],
            "generated_at": event.occurred_at,
            "source_event_id": event.id,
        }
    )


def _build_task_memory(session: Session, task_id, selected_session_ids: Sequence, include_artifacts: bool) -> TaskMemoryRead:
    task_context = get_task_context(session, task_id)
    selected_session_ids_set = set(selected_session_ids)
    selected_sessions = [task_session for task_session in task_context.task_sessions if task_session.id in selected_session_ids_set]
    selected_runs = [
        execution_run
        for execution_run in task_context.execution_runs
        if execution_run.task_session_id in selected_session_ids_set
    ]
    project_memory_entries = extract_memory_entries(
        task_context.latest_project_memory.payload if task_context.latest_project_memory else None
    )

    entries: List[MemoryEntryRead] = []
    constraints = extract_constraints(task_context.task, memory_entries=project_memory_entries)
    if constraints:
        entries.append(
            _entry(
                scope="task",
                source_type="task_definition",
                subject=task_context.task.title,
                summary=f"Stable constraints for this task: {'; '.join(constraints[:3])}.",
                evidence_refs=[_evidence_ref("task", ref_id=str(task_context.task.id))],
                constraints=constraints,
                decision_impact="preserve_constraints",
                confidence=0.78,
                dedupe_seed=f"{task_context.task.id}-constraints",
            )
        )

    failures = previous_failure_count(selected_runs)
    if failures:
        entries.append(
            _entry(
                scope="task",
                source_type="execution_history",
                subject=task_context.task.title,
                summary=f"This task has {failures} failed or blocked execution attempt(s) in recent history.",
                evidence_refs=[_evidence_ref("task", ref_id=str(task_context.task.id))],
                decision_impact="increase_review",
                confidence=0.82,
                dedupe_seed=f"{task_context.task.id}-failures",
            )
        )

    latest_result_event = next(
        (event for event in task_context.events if event.event_type == "result_evaluation.recorded"),
        None,
    )
    if latest_result_event:
        payload = latest_result_event.payload or {}
        entries.append(
            _entry(
                scope="task",
                source_type="result_evaluation",
                subject=task_context.task.title,
                summary=f"Latest result evaluation routes the task to '{payload.get('status', task_context.task.status)}'.",
                evidence_refs=[_evidence_ref("event", ref_id=str(latest_result_event.id))],
                decision_impact=str(payload.get("status", "result_evaluated")),
                confidence=0.76,
                dedupe_seed=f"{task_context.task.id}-result-status-{payload.get('status', task_context.task.status)}",
            )
        )

    latest_policy_event = next(
        (
            event
            for event in task_context.events
            if event.event_type in {"policy.dispatch_decision", "policy.result_decision"}
        ),
        None,
    )
    if latest_policy_event:
        decision = (latest_policy_event.payload or {}).get("decision", {})
        reason_codes = decision.get("reason_codes") or []
        if reason_codes:
            entries.append(
                _entry(
                    scope="task",
                    source_type="policy",
                    subject=task_context.task.title,
                    summary=f"Policy decisions frequently trigger: {', '.join(reason_codes[:4])}.",
                    evidence_refs=[_evidence_ref("event", ref_id=str(latest_policy_event.id))],
                    decision_impact="policy_gate",
                    confidence=0.72,
                    dedupe_seed=f"{task_context.task.id}-policy-{'-'.join(reason_codes[:3])}",
                )
            )

    reviewer_event = next(
        (event for event in task_context.events if event.event_type == "reviewer.decision_recorded"),
        None,
    )
    if reviewer_event and (reviewer_event.payload or {}).get("risky_changes"):
        risky_changes = reviewer_event.payload.get("risky_changes")[:3]
        entries.append(
            _entry(
                scope="task",
                source_type="review",
                subject=task_context.task.title,
                summary=f"Reviewer flags risky change patterns: {', '.join(risky_changes)}.",
                evidence_refs=[_evidence_ref("event", ref_id=str(reviewer_event.id))],
                decision_impact="require_review",
                confidence=0.8,
                dedupe_seed=f"{task_context.task.id}-review-risks",
            )
        )

    qa_event = next(
        (event for event in task_context.events if event.event_type == "qa.decision_recorded"),
        None,
    )
    if qa_event and (qa_event.payload or {}).get("missing_checks"):
        missing_checks = qa_event.payload.get("missing_checks")[:3]
        entries.append(
            _entry(
                scope="task",
                source_type="qa",
                subject=task_context.task.title,
                summary=f"QA repeatedly asks for: {', '.join(missing_checks)}.",
                evidence_refs=[_evidence_ref("event", ref_id=str(qa_event.id))],
                decision_impact="require_qa",
                confidence=0.79,
                dedupe_seed=f"{task_context.task.id}-qa-missing-checks",
            )
        )

    if include_artifacts:
        for task_session in selected_sessions:
            artifact_excerpt = read_artifact_excerpt(task_session.artifact_path, max_chars=4000)
            for line in _interesting_artifact_lines(artifact_excerpt):
                entries.append(
                    _entry(
                        scope="task",
                        source_type="artifact",
                        subject=task_context.task.title,
                        summary=f"Artifact evidence: {line}",
                        evidence_refs=[
                            _evidence_ref(
                                "artifact",
                                ref_id=str(task_session.id),
                                artifact_path=task_session.artifact_path,
                            )
                        ],
                        decision_impact="watch_bug_pattern",
                        confidence=0.61,
                        dedupe_seed=f"{task_context.task.id}-artifact-{line}",
                    )
                )

    deduped_entries = _dedupe_entries(entries)[:10]
    summary_parts = [
        f"{len(deduped_entries)} curated memory entries",
        f"latest task status '{task_context.task.status}'",
    ]
    if failures:
        summary_parts.append(f"{failures} prior failures")
    task_summary = ", ".join(summary_parts) + "."

    return TaskMemoryRead(
        task_id=task_context.task.id,
        project_id=task_context.project.id,
        summary=task_summary,
        entries=deduped_entries,
        generated_at=datetime.now(timezone.utc),
    )


def _build_project_memory(project_id, task_memories: Sequence[TaskMemoryRead], existing_project_memory: Optional[ProjectMemoryRead]) -> ProjectMemoryRead:
    entries: List[MemoryEntryRead] = []
    if existing_project_memory:
        entries.extend(existing_project_memory.entries)
    for task_memory in task_memories:
        entries.extend(task_memory.entries)

    deduped_entries = _dedupe_entries(entries)[:15]
    summary = (
        f"Canonical project memory covers {len(deduped_entries)} reusable constraints, decisions, "
        f"and bug patterns across {len(task_memories)} curated task(s)."
    )
    return ProjectMemoryRead(
        project_id=project_id,
        summary=summary,
        entries=deduped_entries,
        generated_at=datetime.now(timezone.utc),
    )


def _select_sessions(session: Session, request: MemoryCurateRequest) -> List[TaskSession]:
    if request.task_id:
        return session.exec(
            select(TaskSession)
            .where(TaskSession.task_id == request.task_id)
            .order_by(TaskSession.started_at.desc())
            .limit(request.max_sessions)
        ).all()

    if request.project_id:
        plan_ids = session.exec(select(Plan.id).where(Plan.project_id == request.project_id)).all()
        if not plan_ids:
            return []
        task_ids = session.exec(select(Task.id).where(Task.plan_id.in_(plan_ids))).all()
        if not task_ids:
            return []
        return session.exec(
            select(TaskSession)
            .where(TaskSession.task_id.in_(task_ids))
            .order_by(TaskSession.started_at.desc())
            .limit(request.max_sessions)
        ).all()

    return session.exec(
        select(TaskSession).order_by(TaskSession.started_at.desc()).limit(request.max_sessions)
    ).all()


def curate_memory(session: Session, request: MemoryCurateRequest) -> MemoryCurateResponse:
    selected_sessions = _select_sessions(session, request)
    sessions_by_task: Dict = defaultdict(list)
    for task_session in selected_sessions:
        sessions_by_task[task_session.task_id].append(task_session.id)

    task_memories: List[TaskMemoryRead] = []
    task_memory_events = []
    for task_id, session_ids in sessions_by_task.items():
        task_memory = _build_task_memory(
            session,
            task_id=task_id,
            selected_session_ids=session_ids,
            include_artifacts=request.include_artifacts,
        )
        task_memories.append(task_memory)
        task_memory_events.append(
            create_event(
                session,
                project_id=task_memory.project_id,
                task_id=task_memory.task_id,
                event_source="control_plane.memory_curator",
                event_type="memory.task_summary_curated",
                payload=task_memory.model_dump(mode="json"),
            )
        )

    task_memory_by_project: Dict = defaultdict(list)
    for task_memory in task_memories:
        task_memory_by_project[task_memory.project_id].append(task_memory)

    project_memories: List[ProjectMemoryRead] = []
    for project_id, project_task_memories in task_memory_by_project.items():
        existing_event = latest_memory_event(
            session,
            project_id=project_id,
            event_type="memory.project_canonical_curated",
        )
        existing_project_memory = (
            _project_memory_from_event(existing_event, project_id=project_id)
            if existing_event
            else None
        )
        project_memory = _build_project_memory(project_id, project_task_memories, existing_project_memory)
        project_memories.append(project_memory)
        create_event(
            session,
            project_id=project_id,
            event_source="control_plane.memory_curator",
            event_type="memory.project_canonical_curated",
            payload=project_memory.model_dump(mode="json"),
        )

    session.commit()
    for event in task_memory_events:
        event_task_id = event.task_id
        matching_memory = next((memory for memory in task_memories if memory.task_id == event_task_id), None)
        if matching_memory:
            matching_memory.source_event_id = event.id

    return MemoryCurateResponse(
        sessions_scanned=len(selected_sessions),
        tasks_curated=len(task_memories),
        projects_curated=len(project_memories),
        task_memories=task_memories,
        project_memories=project_memories,
    )


def get_task_memory(session: Session, task_id) -> TaskMemoryRead:
    task_context = get_task_context(session, task_id)
    memory_event = task_context.latest_task_memory
    if memory_event:
        return _task_memory_from_event(
            memory_event,
            task_id=task_context.task.id,
            project_id=task_context.project.id,
        )

    return TaskMemoryRead(
        task_id=task_context.task.id,
        project_id=task_context.project.id,
        summary="No curated task memory exists yet.",
        entries=[],
        generated_at=None,
        source_event_id=None,
    )


def get_project_memory(session: Session, project_id) -> ProjectMemoryRead:
    project = session.get(Project, project_id)
    if not project:
        raise LookupError("Project not found")

    memory_event = latest_memory_event(
        session,
        project_id=project_id,
        event_type="memory.project_canonical_curated",
    )
    if memory_event:
        return _project_memory_from_event(memory_event, project_id=project_id)

    return ProjectMemoryRead(
        project_id=project_id,
        summary="No curated project memory exists yet.",
        entries=[],
        generated_at=None,
        source_event_id=None,
    )
