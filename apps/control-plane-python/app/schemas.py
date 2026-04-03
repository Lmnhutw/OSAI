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
    reason_codes: List[str] = Field(default_factory=list)
    evidence: Dict[str, Any] = Field(default_factory=dict)


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
