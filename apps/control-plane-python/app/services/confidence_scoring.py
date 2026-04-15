from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Sequence

from sqlmodel import Session, select

from ..models import Plan, Task
from ..schemas import BugTriageRead, FailurePatternRead, QADecisionRead, ResultEvaluationRead, ReviewerDecisionRead
from .control_plane_support import STOPWORDS, TaskContext, extract_keywords, previous_failure_count
from .sensitive_scope import SensitiveScopeAssessment
from .task_classification import TaskClassification


@dataclass
class ConfidenceAssessment:
    name: str
    score: float
    label: str
    summary: str
    factors: Dict[str, float]

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "score": self.score,
            "label": self.label,
            "summary": self.summary,
            "factors": self.factors,
        }


def _clamp(value: float) -> float:
    return round(max(0.0, min(1.0, value)), 2)


def _label(score: float) -> str:
    if score >= 0.8:
        return "high"
    if score >= 0.6:
        return "medium"
    return "low"


def _assessment(name: str, factors: Dict[str, float]) -> ConfidenceAssessment:
    score = _clamp(sum(factors.values()) / max(len(factors), 1))
    weakest = sorted(factors.items(), key=lambda item: item[1])[:2]
    summary = "Confidence remains steady."
    if weakest:
        summary = "Lower confidence from " + ", ".join(name for name, _ in weakest) + "."
    return ConfidenceAssessment(
        name=name,
        score=score,
        label=_label(score),
        summary=summary,
        factors={key: _clamp(value) for key, value in factors.items()},
    )


def _historical_signals(session: Session, task_context: TaskContext) -> Dict[str, float]:
    project_tasks = session.exec(
        select(Task)
        .join(Plan, Task.plan_id == Plan.id)
        .where(
            Plan.project_id == task_context.project.id,
            Task.id != task_context.task.id,
        )
    ).all()
    current_tokens = {token for token in extract_keywords(task_context.task.title) if token not in STOPWORDS}

    similar_tasks = []
    for task in project_tasks:
        task_tokens = {token for token in extract_keywords(task.title) if token not in STOPWORDS}
        if task.task_type == task_context.task.task_type or current_tokens.intersection(task_tokens):
            similar_tasks.append(task)

    successful = [
        task
        for task in similar_tasks
        if (task.status or "").lower() in {"completed", "done", "approved", "passed"}
    ]
    success_rate = len(successful) / len(similar_tasks) if similar_tasks else 0.5
    novelty_score = 0.55 if not similar_tasks else max(0.55, min(0.9, success_rate + 0.2))
    return {
        "similar_task_count": float(len(similar_tasks)),
        "similar_success_rate": round(success_rate, 2),
        "novelty_score": round(novelty_score, 2),
    }


def score_dispatch_readiness(
    session: Session,
    task_context: TaskContext,
    *,
    classification: TaskClassification,
    sensitive_scope: SensitiveScopeAssessment,
    risk_flags: Sequence[str],
    missing_context: Sequence[str],
) -> ConfidenceAssessment:
    history = _historical_signals(session, task_context)
    failures = previous_failure_count(task_context.execution_runs)
    factors = {
        "scope_clarity": 1 - min(0.75, len(missing_context) * 0.22),
        "dependency_readiness": 0.2 if "blocked_dependency" in risk_flags else 1.0,
        "history_health": max(0.1, 1 - (failures * 0.24)),
        "memory_support": 0.85 if (task_context.latest_task_memory or task_context.latest_project_memory) else 0.55,
        "novelty_alignment": history["novelty_score"],
        "safety_margin": max(
            0.1,
            1
            - (0.08 * len(set(risk_flags)))
            - (0.18 if classification.risk_level == "high" else 0.08 if classification.risk_level == "medium" else 0.0)
            - (sensitive_scope.sensitivity_score * 0.2),
        ),
    }
    return _assessment("dispatch_readiness", factors)


def score_execution_safety(
    task_context: TaskContext,
    *,
    classification: TaskClassification,
    sensitive_scope: SensitiveScopeAssessment,
) -> ConfidenceAssessment:
    failures = previous_failure_count(task_context.execution_runs)
    factors = {
        "classification_headroom": {
            "low": 0.92,
            "medium": 0.68,
            "high": 0.38,
        }[classification.risk_level],
        "scope_headroom": {
            "small": 0.9,
            "medium": 0.7,
            "large": 0.45,
        }[classification.scope_size],
        "architecture_headroom": {
            "localized": 0.9,
            "module": 0.68,
            "cross_cutting": 0.42,
        }[classification.architectural_impact],
        "sensitivity_headroom": max(0.08, 1 - (sensitive_scope.sensitivity_score * 0.7)),
        "failure_headroom": max(0.08, 1 - (failures * 0.22)),
    }
    return _assessment("execution_safety", factors)


def score_post_result_confidence(
    task_context: TaskContext,
    *,
    classification: TaskClassification,
    sensitive_scope: SensitiveScopeAssessment,
    reviewer_decision: ReviewerDecisionRead,
    qa_decision: QADecisionRead,
    result_status: str,
    run_status: str,
) -> ConfidenceAssessment:
    failures = previous_failure_count(task_context.execution_runs)
    factors = {
        "run_health": 0.25 if result_status in {"blocked", "needs_rework"} else 0.95,
        "review_alignment": 0.35
        if reviewer_decision.status == "needs_rework"
        else 0.55
        if reviewer_decision.status == "review_required"
        else 0.9,
        "qa_coverage": max(0.2, 1 - (len(qa_decision.missing_checks) * 0.18) - (len(qa_decision.potential_regressions) * 0.22)),
        "history_health": max(0.1, 1 - (failures * 0.2)),
        "safety_margin": max(
            0.1,
            1
            - (0.2 if classification.risk_level == "high" else 0.08 if classification.risk_level == "medium" else 0.0)
            - (sensitive_scope.sensitivity_score * 0.15)
            - (0.2 if run_status == "blocked" else 0.0),
        ),
    }
    return _assessment("post_result_confidence", factors)


def score_retry_viability(
    task_context: TaskContext,
    *,
    result_evaluation: ResultEvaluationRead,
    bug_triage: BugTriageRead,
    failure_patterns: Sequence[FailurePatternRead],
    retry_count: int,
    max_retry: int,
    retries_disabled: bool,
) -> ConfidenceAssessment:
    recurring_patterns = [pattern for pattern in failure_patterns if pattern.recurring]
    factors = {
        "retry_budget": 0.0 if retries_disabled else max(0.0, 1 - (retry_count / max(max_retry, 1))),
        "result_health": 0.25 if result_evaluation.status == "blocked" else 0.55 if result_evaluation.status == "needs_rework" else 0.85,
        "bug_fixability": {
            "retry": 0.9,
            "fix_task": 0.45,
            "escalate": 0.1,
        }.get(bug_triage.recommended_action, 0.35),
        "pattern_stability": 0.25 if recurring_patterns else 0.78,
        "prior_confidence": max(0.15, result_evaluation.policy_decision.confidence_score or 0.5),
    }
    return _assessment("retry_viability", factors)
