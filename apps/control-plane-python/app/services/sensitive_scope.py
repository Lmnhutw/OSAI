from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Dict, List, Optional, Sequence

from .control_plane_support import (
    TaskContext,
    derive_allowed_paths,
    extract_changed_files,
    extract_constraints,
    flatten_text_fragments,
    normalize_whitespace,
    unique_list,
)

SENSITIVE_PATTERNS: Dict[str, Sequence[str]] = {
    "authentication": ("auth", "oauth", "login", "token", "permission", "session", "credential"),
    "billing_payments": ("billing", "payment", "invoice", "charge", "subscription", "ledger", "stripe"),
    "security_critical": ("security", "secret", "encrypt", "vulnerability", "policy", "access control"),
    "schema_migration": ("schema", "migration", "database", "sql", "table", "column"),
    "deployment_config": ("deploy", "deployment", "production", "infra", "config", "pipeline", "docker", "kubernetes"),
}

SHARED_CORE_PATH_MARKERS = (
    "app/models.py",
    "app/schemas.py",
    "app/database.py",
    "app/services/control_plane_support.py",
    "app/services/policy_engine.py",
    "app/services/loop_controller.py",
)

FORBIDDEN_ACTION_PATTERNS: Dict[str, Sequence[str]] = {
    "destructive_schema_change": (r"\bdrop table\b", r"\btruncate\b", r"\bdelete from\b"),
    "production_deploy": (r"\bdeploy(?:ment)? to production\b", r"\bproduction rollout\b"),
    "secret_rotation": (r"\brotate (?:secret|credential|token)\b", r"\bchange .*secret\b"),
    "auth_bypass": (r"\bdisable auth(?:entication)?\b", r"\bbypass permission\b"),
    "billing_live_capture": (r"\bcapture live payment\b", r"\bsettle invoice\b"),
}


@dataclass
class SensitiveScopeAssessment:
    domains: List[str]
    matched_paths: List[str]
    reasons: List[str]
    sensitivity_score: float
    forbidden_actions: List[str]

    @property
    def is_sensitive(self) -> bool:
        return bool(self.domains or self.matched_paths)

    def as_dict(self) -> dict:
        return {
            "domains": self.domains,
            "matched_paths": self.matched_paths,
            "reasons": self.reasons,
            "sensitivity_score": self.sensitivity_score,
            "forbidden_actions": self.forbidden_actions,
        }


def _combined_text(task_context: TaskContext, changed_files: Sequence[str]) -> str:
    fragments = [
        task_context.task.task_type,
        task_context.task.title,
        task_context.task.instructions,
        *flatten_text_fragments(task_context.task.input_payload),
        *changed_files,
    ]
    return normalize_whitespace(" ".join(fragment for fragment in fragments if fragment)).lower()


def detect_sensitive_scope(
    task_context: TaskContext,
    *,
    changed_files: Optional[Sequence[str]] = None,
    extra_sensitive_modules: Optional[Sequence[str]] = None,
) -> SensitiveScopeAssessment:
    changed_files = unique_list(changed_files or extract_changed_files(task_context.task.input_payload))
    constraints = extract_constraints(task_context.task)
    allowed_paths = derive_allowed_paths(constraints)
    candidate_paths = unique_list([*changed_files, *allowed_paths, *(extra_sensitive_modules or [])])
    lowered_paths = [path.replace("\\", "/").lower().strip("/") for path in candidate_paths]
    text = _combined_text(task_context, changed_files)

    domains: List[str] = []
    reasons: List[str] = []
    matched_paths: List[str] = []

    for domain, keywords in SENSITIVE_PATTERNS.items():
        if any(keyword in text for keyword in keywords):
            domains.append(domain)
            reasons.append(f"{domain}_keywords")
        path_hits = [path for path in lowered_paths if any(keyword in path for keyword in keywords)]
        if path_hits:
            domains.append(domain)
            matched_paths.extend(path_hits)
            reasons.append(f"{domain}_paths")

    shared_core_hits = [path for path in lowered_paths if any(marker in path for marker in SHARED_CORE_PATH_MARKERS)]
    if shared_core_hits:
        domains.append("shared_core_library")
        matched_paths.extend(shared_core_hits)
        reasons.append("shared_core_paths")

    forbidden_actions: List[str] = []
    for action, patterns in FORBIDDEN_ACTION_PATTERNS.items():
        if any(re.search(pattern, text) for pattern in patterns):
            forbidden_actions.append(action)

    domains = unique_list(domains)
    matched_paths = unique_list(matched_paths)
    reasons = unique_list(reasons)
    sensitivity_score = min(1.0, round((len(domains) * 0.24) + (len(matched_paths) * 0.06), 2))

    return SensitiveScopeAssessment(
        domains=domains,
        matched_paths=matched_paths,
        reasons=reasons,
        sensitivity_score=sensitivity_score,
        forbidden_actions=unique_list(forbidden_actions),
    )
