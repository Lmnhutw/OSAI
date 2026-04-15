from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Optional, Sequence

from .control_plane_support import (
    HIGH_RISK_TASK_TYPES,
    TaskContext,
    extract_acceptance_criteria,
    extract_changed_files,
    extract_constraints,
    flatten_text_fragments,
    normalize_whitespace,
    unique_list,
)

BUGFIX_KEYWORDS = {"bug", "fix", "hotfix", "regression", "repair", "incident", "triage"}
REFACTOR_KEYWORDS = {"refactor", "cleanup", "simplify", "rename", "restructure", "modularize"}
TEST_ONLY_KEYWORDS = {"test", "tests", "qa", "validate", "verification", "coverage", "assert"}
ARCHITECTURE_KEYWORDS = {
    "architecture",
    "interface",
    "shared",
    "core",
    "orchestrator",
    "policy engine",
}
SCHEMA_KEYWORDS = {"schema", "migration", "database", "sql", "table", "column", "ddl"}
INFRA_KEYWORDS = {"deploy", "deployment", "infra", "production", "config", "pipeline", "docker", "kubernetes"}
HUMAN_ONLY_KEYWORDS = {"legal", "compliance", "manual approval", "human-only", "finance approval"}
IMPLEMENTATION_KEYWORDS = {"implement", "build", "create", "update", "change", "deliver"}
CORE_PATH_MARKERS = {
    "app/models.py",
    "app/schemas.py",
    "app/database.py",
    "app/services/control_plane_support.py",
    "app/services/policy_engine.py",
    "app/services/loop_controller.py",
}


@dataclass
class TaskClassification:
    category: str
    risk_level: str
    scope_size: str
    architectural_impact: str
    reasons: List[str]

    def as_dict(self) -> dict:
        return {
            "category": self.category,
            "risk_level": self.risk_level,
            "scope_size": self.scope_size,
            "architectural_impact": self.architectural_impact,
            "reasons": self.reasons,
        }


def _combined_text(task_context: TaskContext, changed_files: Optional[Sequence[str]]) -> str:
    fragments: List[str] = [
        task_context.task.task_type,
        task_context.task.title,
        task_context.task.instructions,
        *flatten_text_fragments(task_context.task.input_payload),
        *(changed_files or []),
    ]
    return normalize_whitespace(" ".join(fragment for fragment in fragments if fragment))


def _count_root_areas(paths: Iterable[str]) -> int:
    roots = set()
    for path in paths:
        normalized = path.replace("\\", "/").strip("/")
        if not normalized:
            continue
        parts = normalized.split("/")
        roots.add("/".join(parts[:2]) if len(parts) >= 2 else parts[0])
    return len(roots)


def _scope_size(
    *,
    changed_files: Sequence[str],
    acceptance_criteria: Sequence[str],
    constraints: Sequence[str],
    instructions: str,
) -> str:
    file_count = len(unique_list(changed_files))
    signal_count = file_count or (len(acceptance_criteria) + len(constraints))
    if signal_count <= 2 and len(instructions) < 240:
        return "small"
    if signal_count <= 5 and len(instructions) < 520:
        return "medium"
    return "large"


def _architectural_impact(text: str, changed_files: Sequence[str]) -> str:
    lowered_files = {path.replace("\\", "/").lower() for path in changed_files}
    if any(marker in lowered_files for marker in CORE_PATH_MARKERS):
        return "cross_cutting"
    if any(keyword in text for keyword in ARCHITECTURE_KEYWORDS):
        return "cross_cutting"
    if _count_root_areas(changed_files) >= 3 or len(unique_list(changed_files)) >= 5:
        return "module"
    return "localized"


def _matches_any(text: str, keywords: Sequence[str]) -> bool:
    return any(keyword in text for keyword in keywords)


def classify_task(
    task_context: TaskContext,
    *,
    changed_files: Optional[Sequence[str]] = None,
) -> TaskClassification:
    changed_files = unique_list(changed_files or extract_changed_files(task_context.task.input_payload))
    acceptance_criteria = extract_acceptance_criteria(task_context.task, task_context.requirements)
    constraints = extract_constraints(task_context.task)
    text = _combined_text(task_context, changed_files).lower()
    scope_size = _scope_size(
        changed_files=changed_files,
        acceptance_criteria=acceptance_criteria,
        constraints=constraints,
        instructions=task_context.task.instructions,
    )
    architectural_impact = _architectural_impact(text, changed_files)
    reasons: List[str] = []

    if _matches_any(text, HUMAN_ONLY_KEYWORDS):
        reasons.append("human_only_scope")
        return TaskClassification(
            category="human_only",
            risk_level="high",
            scope_size=scope_size,
            architectural_impact=architectural_impact,
            reasons=reasons,
        )

    if task_context.task.task_type in {"migration", "database"} or _matches_any(text, SCHEMA_KEYWORDS):
        reasons.append("schema_or_migration_scope")
        return TaskClassification(
            category="schema_sensitive",
            risk_level="high",
            scope_size=scope_size,
            architectural_impact="cross_cutting" if architectural_impact == "cross_cutting" else "module",
            reasons=reasons,
        )

    if task_context.task.task_type in {"infra", "deployment"} or _matches_any(text, INFRA_KEYWORDS):
        reasons.append("infra_or_production_scope")
        return TaskClassification(
            category="infra_sensitive",
            risk_level="high",
            scope_size=scope_size,
            architectural_impact="cross_cutting" if architectural_impact == "cross_cutting" else "module",
            reasons=reasons,
        )

    if architectural_impact == "cross_cutting":
        reasons.append("cross_cutting_or_shared_core")
        return TaskClassification(
            category="architecture_sensitive",
            risk_level="high",
            scope_size=scope_size,
            architectural_impact=architectural_impact,
            reasons=reasons,
        )

    test_only = (
        task_context.task.task_type in {"verification", "test", "qa"}
        or (_matches_any(text, TEST_ONLY_KEYWORDS) and not _matches_any(text, IMPLEMENTATION_KEYWORDS))
        or (changed_files and all("tests/" in path.replace("\\", "/").lower() for path in changed_files))
    )
    if test_only:
        reasons.append("test_only_scope")
        return TaskClassification(
            category="test_only",
            risk_level="low" if scope_size != "large" else "medium",
            scope_size=scope_size,
            architectural_impact=architectural_impact,
            reasons=reasons,
        )

    if _matches_any(text, BUGFIX_KEYWORDS):
        reasons.append("bugfix_keywords")
        return TaskClassification(
            category="bugfix",
            risk_level="medium" if scope_size != "small" else "low",
            scope_size=scope_size,
            architectural_impact=architectural_impact,
            reasons=reasons,
        )

    if _matches_any(text, REFACTOR_KEYWORDS):
        reasons.append("refactor_keywords")
        return TaskClassification(
            category="refactor",
            risk_level="medium" if architectural_impact == "localized" else "high",
            scope_size=scope_size,
            architectural_impact=architectural_impact,
            reasons=reasons,
        )

    if task_context.task.task_type in HIGH_RISK_TASK_TYPES or scope_size == "large":
        reasons.append("large_or_high_risk_implementation")
        return TaskClassification(
            category="high_risk_implementation",
            risk_level="high",
            scope_size=scope_size,
            architectural_impact=architectural_impact,
            reasons=reasons,
        )

    if scope_size == "medium" or architectural_impact == "module":
        reasons.append("moderate_scope_implementation")
        return TaskClassification(
            category="medium_risk_implementation",
            risk_level="medium",
            scope_size=scope_size,
            architectural_impact=architectural_impact,
            reasons=reasons,
        )

    reasons.append("localized_low_risk_scope")
    return TaskClassification(
        category="low_risk_implementation",
        risk_level="low",
        scope_size=scope_size,
        architectural_impact=architectural_impact,
        reasons=reasons,
    )
