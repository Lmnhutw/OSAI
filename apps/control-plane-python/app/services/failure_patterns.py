from __future__ import annotations

from typing import List

from sqlmodel import Session

from ..schemas import BugTriageRead, FailurePatternRead, ResultEvaluationRead
from .control_plane_support import (
    TaskContext,
    extract_keywords,
    extract_memory_entries,
    get_task_loop_history,
    unique_list,
)


def _matching_keywords(pattern_key: str, texts: List[str]) -> List[str]:
    keywords = extract_keywords(pattern_key)
    if not keywords:
        return []
    matches: List[str] = []
    for text in texts:
        lowered = text.lower()
        if any(keyword in lowered for keyword in keywords[:4]):
            matches.append(text)
    return unique_list(matches)


def detect_failure_patterns(
    session: Session,
    task_context: TaskContext,
    result_evaluation: ResultEvaluationRead,
    bug_triage: BugTriageRead,
) -> List[FailurePatternRead]:
    history_entries = get_task_loop_history(session, task_context.task.id)
    history_evidence: List[str] = []
    occurrence_count = 1

    for entry in history_entries:
        if entry.failure_pattern_key == bug_triage.pattern_key or entry.bug_category == bug_triage.category:
            occurrence_count += 1
            if entry.summary:
                history_evidence.append(entry.summary)

    task_memory_entries = extract_memory_entries(
        task_context.latest_task_memory.payload if task_context.latest_task_memory else None
    )
    project_memory_entries = extract_memory_entries(
        task_context.latest_project_memory.payload if task_context.latest_project_memory else None
    )
    memory_texts = [
        str(entry.get("summary", ""))
        for entry in [*task_memory_entries, *project_memory_entries]
        if isinstance(entry, dict)
    ]
    memory_hits = _matching_keywords(bug_triage.pattern_key, memory_texts)
    occurrence_count += len(memory_hits)

    evidence = unique_list(
        [
            *bug_triage.evidence[:4],
            *result_evaluation.risk_flags,
            *history_evidence[:4],
        ]
    )

    return [
        FailurePatternRead(
            pattern_key=bug_triage.pattern_key,
            category=bug_triage.category,
            occurrence_count=occurrence_count,
            recurring=occurrence_count >= 3,
            evidence=evidence[:6],
            memory_hits=memory_hits[:4],
        )
    ]
