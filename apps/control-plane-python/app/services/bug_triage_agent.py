from __future__ import annotations

from typing import List

from ..schemas import BugTriageRead, ResultEvaluationRead
from .control_plane_support import RunContext, extract_keywords, slugify, unique_list

INFRA_TERMS = {
    "timeout",
    "timed out",
    "connection",
    "network",
    "dns",
    "unavailable",
    "refused",
    "dependency",
    "infra",
    "environment",
    "service unavailable",
}
SPEC_FLAGS = {"missing_acceptance_criteria", "missing_constraints", "unclear_scope", "blocked_dependency"}
TEST_TERMS = {"test", "tests", "qa", "validation", "assert", "regression"}


def _build_pattern_key(category: str, evidence: List[str]) -> str:
    keywords: List[str] = []
    for fragment in evidence:
        keywords.extend(extract_keywords(fragment)[:2])
    suffix = "-".join(unique_list(keywords)[:4])
    return slugify(f"{category}-{suffix}" if suffix else category)


def triage_run_failure(run_context: RunContext, result_evaluation: ResultEvaluationRead) -> BugTriageRead:
    run_error = run_context.execution_run.error_message or ""
    reviewer = result_evaluation.reviewer_decision
    qa = result_evaluation.qa_decision

    evidence = unique_list(
        [
            run_error,
            *result_evaluation.risk_flags,
            *reviewer.unmet_acceptance_criteria,
            *reviewer.risky_changes,
            *qa.missing_checks,
            *qa.potential_regressions,
            *reviewer.notes,
            *qa.notes,
        ]
    )
    lowered_evidence = " ".join(evidence).lower()
    lowered_error = run_error.lower()

    category = "code_bug"
    confidence = 0.62
    if result_evaluation.status == "blocked" or any(term in lowered_error for term in INFRA_TERMS):
        category = "infra_issue"
        confidence = 0.84
    elif reviewer.scope_deviation or any(flag in SPEC_FLAGS for flag in result_evaluation.risk_flags):
        category = "spec_issue"
        confidence = 0.79
    elif qa.missing_checks or any(term in lowered_evidence for term in TEST_TERMS):
        category = "test_issue"
        confidence = 0.71
    elif run_error or reviewer.unmet_acceptance_criteria:
        category = "code_bug"
        confidence = 0.78

    recommended_action = "fix_task"
    if category == "infra_issue":
        recommended_action = "retry"
    elif category == "spec_issue":
        recommended_action = "escalate"

    summary = {
        "infra_issue": "Execution failed because the stored evidence points to infrastructure or dependency instability.",
        "code_bug": "Execution evidence indicates the implementation itself failed or missed acceptance criteria.",
        "spec_issue": "The failure is rooted in missing scope, constraints, or requirement clarity rather than execution alone.",
        "test_issue": "The task output is missing test or validation evidence, so follow-up verification work is required.",
    }[category]

    return BugTriageRead(
        category=category,
        recommended_action=recommended_action,
        confidence=confidence,
        summary=summary,
        pattern_key=_build_pattern_key(category, evidence),
        evidence=evidence[:8],
    )
