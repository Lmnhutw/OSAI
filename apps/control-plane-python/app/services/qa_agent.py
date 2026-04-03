from typing import List

from ..schemas import QADecisionRead, ReviewerDecisionRead, ValidationCheckRead
from .control_plane_support import (
    REGRESSION_PRONE_PATH_TERMS,
    RunContext,
    collect_output_evidence,
    criterion_has_evidence,
    extract_acceptance_criteria,
    extract_changed_files,
)


def run_lightweight_qa(run_context: RunContext, reviewer_decision: ReviewerDecisionRead) -> QADecisionRead:
    acceptance_criteria = extract_acceptance_criteria(
        run_context.task_context.task,
        run_context.task_context.requirements,
    )
    evidence_text = collect_output_evidence(
        run_context.execution_run,
        run_context.task_session,
        [*run_context.session_events, *run_context.run_events],
    )
    lowered_evidence = evidence_text.lower()
    changed_files = extract_changed_files(run_context.execution_run.output_payload)

    validation_checks: List[ValidationCheckRead] = []
    for criterion in acceptance_criteria:
        covered = criterion_has_evidence(criterion, evidence_text)
        validation_checks.append(
            ValidationCheckRead(
                acceptance_criterion=criterion,
                status="covered" if covered else "missing_evidence",
                evidence="output_payload_or_artifact" if covered else None,
            )
        )

    missing_checks: List[str] = []
    if not acceptance_criteria:
        missing_checks.append("No acceptance criteria were recorded, so QA could not map explicit validations.")
    if not any(token in lowered_evidence for token in ("test", "tests", "assert", "validated", "verification", "qa")):
        missing_checks.append("Execution result does not include explicit test or validation evidence.")
    if any(check.status == "missing_evidence" for check in validation_checks):
        missing_checks.append("Some acceptance criteria do not have supporting evidence in the stored run output.")

    potential_regressions: List[str] = []
    for changed_file in changed_files:
        lowered_file = changed_file.lower()
        if any(term in lowered_file for term in REGRESSION_PRONE_PATH_TERMS):
            potential_regressions.append(
                f"Changed file '{changed_file}' touches a regression-prone surface and should receive targeted checks."
            )
    if changed_files and not any(token in lowered_evidence for token in ("test", "qa", "verification")):
        potential_regressions.append("Changed files are present without corresponding regression evidence.")
    potential_regressions.extend(reviewer_decision.risky_changes[:3])

    notes: List[str] = []
    if reviewer_decision.scope_deviation:
        notes.append("QA should verify scope deviations before trusting the execution result.")
    if reviewer_decision.unmet_acceptance_criteria:
        notes.append("Reviewer already found unmet acceptance criteria, so QA is advisory until rework occurs.")

    status = "pass"
    if missing_checks or potential_regressions:
        status = "qa_pending"

    return QADecisionRead(
        status=status,
        validation_checks=validation_checks,
        missing_checks=list(dict.fromkeys(missing_checks)),
        potential_regressions=list(dict.fromkeys(potential_regressions)),
        notes=notes,
    )
