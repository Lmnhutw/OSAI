from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import datetime
import uuid

# Project Schemas
class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = None

class ProjectRead(ProjectCreate):
    id: uuid.UUID
    status: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

# Requirement Schemas
class ProjectRequirementCreate(BaseModel):
    requirement_text: str
    position: int

class ProjectRequirementRead(ProjectRequirementCreate):
    id: uuid.UUID
    project_id: uuid.UUID
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

# Plan Schemas
class PlanRead(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    version: int
    title: str
    summary: Optional[str] = None
    status: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

# Task Schemas
class TaskRead(BaseModel):
    id: uuid.UUID
    plan_id: uuid.UUID
    position: int
    task_type: str
    title: str
    instructions: str
    status: str
    input_payload: Dict[str, Any]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

# Approval Schemas
class ApprovalCreate(BaseModel):
    requested_by: str
    decision_note: Optional[str] = None

class ApprovalRead(BaseModel):
    id: uuid.UUID
    plan_id: uuid.UUID
    requested_by: str
    approver: Optional[str] = None
    status: str
    decision_note: Optional[str] = None
    requested_at: datetime
    decided_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

class TaskDependencyRead(BaseModel):
    id: uuid.UUID
    task_id: uuid.UUID
    depends_on_task_id: uuid.UUID
    dependency_type: str
    created_at: datetime

    class Config:
        from_attributes = True

class TaskRelationshipRead(BaseModel):
    id: uuid.UUID
    parent_task_id: uuid.UUID
    child_task_id: uuid.UUID
    relationship_type: str
    metadata: Dict[str, Any] = Field(validation_alias="relationship_metadata")
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

class TaskLoopStateRead(BaseModel):
    id: uuid.UUID
    task_id: uuid.UUID
    status: str
    current_action: Optional[str] = None
    retry_count: int
    consecutive_failures: int
    chain_depth: int
    follow_up_count: int
    last_result_status: Optional[str] = None
    last_bug_category: Optional[str] = None
    last_failure_pattern: Optional[str] = None
    last_task_session_id: Optional[uuid.UUID] = None
    last_run_id: Optional[uuid.UUID] = None
    loop_started_at: datetime
    last_transition_at: datetime
    timeout_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

class TaskLoopHistoryEntryRead(BaseModel):
    id: uuid.UUID
    task_loop_id: Optional[uuid.UUID] = None
    task_id: uuid.UUID
    task_session_id: Optional[uuid.UUID] = None
    execution_run_id: Optional[uuid.UUID] = None
    action: str
    task_status: Optional[str] = None
    result_status: Optional[str] = None
    bug_category: Optional[str] = None
    failure_pattern_key: Optional[str] = None
    retry_count: int
    chain_depth: int
    summary: Optional[str] = None
    payload: Dict[str, Any]
    created_at: datetime

    class Config:
        from_attributes = True

class TaskSessionRead(BaseModel):
    id: uuid.UUID
    task_id: uuid.UUID
    status: str
    artifact_path: Optional[str] = None
    metadata: Dict[str, Any] = Field(validation_alias="session_metadata")
    started_at: datetime
    ended_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

class ExecutionRunRead(BaseModel):
    id: uuid.UUID
    task_session_id: uuid.UUID
    attempt_no: int
    status: str
    worker_name: Optional[str] = None
    artifact_path: Optional[str] = None
    input_payload: Dict[str, Any]
    output_payload: Dict[str, Any]
    error_message: Optional[str] = None
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

class EventRead(BaseModel):
    id: uuid.UUID
    project_id: Optional[uuid.UUID] = None
    plan_id: Optional[uuid.UUID] = None
    task_id: Optional[uuid.UUID] = None
    task_session_id: Optional[uuid.UUID] = None
    execution_run_id: Optional[uuid.UUID] = None
    event_source: str
    event_type: str
    artifact_path: Optional[str] = None
    payload: Dict[str, Any]
    occurred_at: datetime
    created_at: datetime

    class Config:
        from_attributes = True

class BatchTaskApprove(BaseModel):
    task_ids: List[uuid.UUID]


class DependencyStatusRead(BaseModel):
    task_id: uuid.UUID
    title: str
    status: str
    dependency_type: str


class PolicyDecisionRead(BaseModel):
    allow_auto_execute: bool
    require_review: bool
    require_qa: bool
    require_approval: bool
    block: bool
    escalate: bool
    retry_allowed: bool
    manual_break_required: bool = False
    max_retry: int = 0
    max_chain_depth: int = 0
    loop_timeout_seconds: int = 0
    risk_threshold: str = "medium"
    reason_codes: List[str] = Field(default_factory=list)
    evidence: Dict[str, Any] = Field(default_factory=dict)


class FailurePatternRead(BaseModel):
    pattern_key: str
    category: str
    occurrence_count: int
    recurring: bool = False
    evidence: List[str] = Field(default_factory=list)
    memory_hits: List[str] = Field(default_factory=list)


class BugTriageRead(BaseModel):
    category: str
    recommended_action: str
    confidence: float = 0.0
    summary: str
    pattern_key: str
    evidence: List[str] = Field(default_factory=list)


class LoopDecisionRead(BaseModel):
    task_id: uuid.UUID
    run_id: Optional[uuid.UUID] = None
    next_action: str
    status: str
    reasons: List[str] = Field(default_factory=list)
    requires_human: bool = False
    retry_count: int
    chain_depth: int
    follow_up_task_id: Optional[uuid.UUID] = None
    chained_task_ids: List[uuid.UUID] = Field(default_factory=list)
    bug_triage: Optional[BugTriageRead] = None
    failure_patterns: List[FailurePatternRead] = Field(default_factory=list)
    policy_decision: PolicyDecisionRead
    loop_state: TaskLoopStateRead
    decided_at: datetime


class DispatchEvaluationRead(BaseModel):
    task_id: uuid.UUID
    status: str
    ready_for_execution: bool
    risk_level: str
    missing_context: List[str] = Field(default_factory=list)
    risk_flags: List[str] = Field(default_factory=list)
    acceptance_criteria: List[str] = Field(default_factory=list)
    constraints: List[str] = Field(default_factory=list)
    dependencies: List[DependencyStatusRead] = Field(default_factory=list)
    execution_payload: Dict[str, Any] = Field(default_factory=dict)
    policy_decision: PolicyDecisionRead
    evaluated_at: datetime


class ReviewerDecisionRead(BaseModel):
    status: str
    matched_acceptance_criteria: List[str] = Field(default_factory=list)
    unmet_acceptance_criteria: List[str] = Field(default_factory=list)
    scope_deviation: bool = False
    risky_changes: List[str] = Field(default_factory=list)
    notes: List[str] = Field(default_factory=list)


class ValidationCheckRead(BaseModel):
    acceptance_criterion: str
    status: str
    evidence: Optional[str] = None


class QADecisionRead(BaseModel):
    status: str
    validation_checks: List[ValidationCheckRead] = Field(default_factory=list)
    missing_checks: List[str] = Field(default_factory=list)
    potential_regressions: List[str] = Field(default_factory=list)
    notes: List[str] = Field(default_factory=list)


class ResultEvaluationRead(BaseModel):
    run_id: uuid.UUID
    task_id: uuid.UUID
    task_session_id: uuid.UUID
    status: str
    risk_flags: List[str] = Field(default_factory=list)
    follow_up_actions: List[str] = Field(default_factory=list)
    reviewer_decision: ReviewerDecisionRead
    qa_decision: QADecisionRead
    policy_decision: PolicyDecisionRead
    loop_decision: Optional[LoopDecisionRead] = None
    evaluated_at: datetime


class MemoryEvidenceRefRead(BaseModel):
    source_type: str
    ref_id: Optional[str] = None
    artifact_path: Optional[str] = None
    note: Optional[str] = None


class MemoryEntryRead(BaseModel):
    scope: str
    source_type: str
    subject: str
    summary: str
    evidence_refs: List[MemoryEvidenceRefRead] = Field(default_factory=list)
    constraints: List[str] = Field(default_factory=list)
    decision_impact: str
    confidence: float = 0.0
    dedupe_key: str
    updated_at: Optional[datetime] = None


class TaskMemoryRead(BaseModel):
    task_id: uuid.UUID
    project_id: uuid.UUID
    summary: Optional[str] = None
    entries: List[MemoryEntryRead] = Field(default_factory=list)
    generated_at: Optional[datetime] = None
    source_event_id: Optional[uuid.UUID] = None


class ProjectMemoryRead(BaseModel):
    project_id: uuid.UUID
    summary: Optional[str] = None
    entries: List[MemoryEntryRead] = Field(default_factory=list)
    generated_at: Optional[datetime] = None
    source_event_id: Optional[uuid.UUID] = None


class MemoryCurateRequest(BaseModel):
    project_id: Optional[uuid.UUID] = None
    task_id: Optional[uuid.UUID] = None
    max_sessions: int = 50
    include_artifacts: bool = True


class MemoryCurateResponse(BaseModel):
    sessions_scanned: int
    tasks_curated: int
    projects_curated: int
    task_memories: List[TaskMemoryRead] = Field(default_factory=list)
    project_memories: List[ProjectMemoryRead] = Field(default_factory=list)


class LoopNextRequest(BaseModel):
    run_id: Optional[uuid.UUID] = None


class RetryRequest(BaseModel):
    reason: Optional[str] = None
    run_id: Optional[uuid.UUID] = None


class RetryResponse(BaseModel):
    task_id: uuid.UUID
    status: str
    retry_count: int
    next_attempt_no: int
    reason: Optional[str] = None
    dispatch_evaluation: Optional[DispatchEvaluationRead] = None
    scheduled_at: datetime


class FollowUpTaskCreateRequest(BaseModel):
    title: Optional[str] = None
    instructions: Optional[str] = None
    task_type: str = "follow_up"
    reason: Optional[str] = None
    acceptance_criteria: List[str] = Field(default_factory=list)
    constraints: List[str] = Field(default_factory=list)
    relation_type: str = "follow_up"
    push_to_jira: bool = False


class FollowUpTaskRead(BaseModel):
    task: TaskRead
    relationship: TaskRelationshipRead
    dependency: Optional[TaskDependencyRead] = None
    jira_sync_status: str = "skipped"


class TaskHistoryEventRead(BaseModel):
    timestamp: datetime
    source: str
    entry_type: str
    summary: str
    task_status: Optional[str] = None
    task_session_id: Optional[uuid.UUID] = None
    execution_run_id: Optional[uuid.UUID] = None
    related_task_id: Optional[uuid.UUID] = None
    payload: Dict[str, Any] = Field(default_factory=dict)


class TaskHistoryRead(BaseModel):
    task_id: uuid.UUID
    loop_state: Optional[TaskLoopStateRead] = None
    relationships: List[TaskRelationshipRead] = Field(default_factory=list)
    loop_history: List[TaskLoopHistoryEntryRead] = Field(default_factory=list)
    entries: List[TaskHistoryEventRead] = Field(default_factory=list)
