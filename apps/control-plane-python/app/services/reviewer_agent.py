from typing import List

from ..schemas import ReviewerDecisionRead
from .control_plane_support import (
    HIGH_RISK_KEYWORDS,
    REGRESSION_PRONE_PATH_TERMS,
    RunContext,
    collect_output_evidence,
    criterion_has_evidence,
    derive_allowed_paths,
    extract_acceptance_criteria,
    extract_changed_files,
    extract_constraints,
    extract_memory_entries,
)


def review_execution_output(run_context: RunContext) -> ReviewerDecisionRead:
    task_context = run_context.task_context
    project_memory_entries = extract_memory_entries(
        task_context.latest_project_memory.payload if task_context.latest_project_memory else None
    )
    task_memory_entries = extract_memory_entries(
        task_context.latest_task_memory.payload if task_context.latest_task_memory else None
    )
    acceptance_criteria = extract_acceptance_criteria(task_context.task, task_context.requirements)
    constraints = extract_constraints(
        task_context.task,
        memory_entries=[*project_memory_entries, *task_memory_entries],
    )
    evidence_text = collect_output_evidence(
        run_context.execution_run,
        run_context.task_session,
        [*run_context.session_events, *run_context.run_events],
    )

    matched_acceptance_criteria: List[str] = []
    unmet_acceptance_criteria: List[str] = []
    for criterion in acceptance_criteria:
        if criterion_has_evidence(criterion, evidence_text):
            matched_acceptance_criteria.append(criterion)
        else:
            unmet_acceptance_criteria.append(criterion)

    changed_files = extract_changed_files(run_context.execution_run.output_payload)
    allowed_paths = derive_allowed_paths(constraints)
    scope_deviation = False
    risky_changes: List[str] = []
    if allowed_paths and changed_files:
        normalized_allowed = [path.strip("/") for path in allowed_paths]
        for changed_file in changed_files:
            normalized_file = changed_file.replace("\\", "/").strip("/")
            if not any(normalized_file.startswith(path) for path in normalized_allowed):
                scope_deviation = True
                risky_changes.append(
                    f"Changed file '{changed_file}' falls outside the recorded task constraints."
                )

    lowered_evidence = evidence_text.lower()
    if any(keyword in lowered_evidence for keyword in HIGH_RISK_KEYWORDS):
        risky_changes.append("Execution evidence touches a high-risk change surface.")

    for changed_file in changed_files:
        lowered_file = changed_file.lower()
        if any(term in lowered_file for term in REGRESSION_PRONE_PATH_TERMS):
            risky_changes.append(f"Changed file '{changed_file}' is regression-prone.")

    notes: List[str] = []
    if not evidence_text:
        notes.append("Execution run does not include output evidence or artifact content.")
    if not acceptance_criteria:
        notes.append("Reviewer could not validate output because acceptance criteria were not recorded.")
    if not changed_files:
        notes.append("Execution output does not list changed files.")

    status = "pass"
    if scope_deviation or unmet_acceptance_criteria:
        status = "needs_rework"
    elif risky_changes or not evidence_text:
        status = "review_required"

    return ReviewerDecisionRead(
        status=status,
        matched_acceptance_criteria=matched_acceptance_criteria,
        unmet_acceptance_criteria=unmet_acceptance_criteria,
        scope_deviation=scope_deviation,
        risky_changes=list(dict.fromkeys(risky_changes)),
        notes=notes,
    )
