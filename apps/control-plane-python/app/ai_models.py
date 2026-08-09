"""SQLModel mappings for the model-agnostic AI runtime schema."""

import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlmodel import Boolean, Column, DateTime, Field, Integer, JSON, Numeric, SQLModel, Text

from .models import utcnow


class ModelProvider(SQLModel, table=True):
    __tablename__ = "model_providers"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    provider_key: str = Field(sa_type=Text)
    provider_type: str = Field(sa_type=Text)
    display_name: str = Field(sa_type=Text)
    base_url: Optional[str] = Field(default=None, sa_type=Text)
    secret_ref: Optional[str] = Field(default=None, sa_type=Text)
    enabled: bool = Field(default=True, sa_type=Boolean)
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    updated_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))


class ModelConfiguration(SQLModel, table=True):
    __tablename__ = "model_configurations"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    profile: str = Field(sa_type=Text)
    provider_id: uuid.UUID = Field(foreign_key="model_providers.id")
    model_name: str = Field(sa_type=Text)
    temperature: float = Field(default=0.2, sa_type=Numeric(3, 2))
    max_output_tokens: int = Field(default=4096, sa_type=Integer)
    timeout_seconds: int = Field(default=60, sa_type=Integer)
    max_retries: int = Field(default=1, sa_type=Integer)
    capabilities: List[str] = Field(default_factory=list, sa_column=Column(JSON))
    enabled: bool = Field(default=True, sa_type=Boolean)
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    updated_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))


class PromptVersion(SQLModel, table=True):
    __tablename__ = "prompt_versions"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    agent_key: str = Field(sa_type=Text)
    version: int = Field(sa_type=Integer)
    system_prompt: str = Field(sa_type=Text)
    input_schema: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    output_schema: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    prompt_checksum: str = Field(sa_type=Text)
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))


class AgentDefinition(SQLModel, table=True):
    __tablename__ = "agent_definitions"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    agent_key: str = Field(sa_type=Text)
    display_name: str = Field(sa_type=Text)
    model_profile: str = Field(foreign_key="model_configurations.profile")
    active_prompt_version_id: Optional[uuid.UUID] = Field(default=None, foreign_key="prompt_versions.id")
    approval_policy: str = Field(default="approval_required", sa_type=Text)
    tool_permissions: List[str] = Field(default_factory=list, sa_column=Column(JSON))
    enabled: bool = Field(default=True, sa_type=Boolean)
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    updated_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))


class WorkflowRun(SQLModel, table=True):
    __tablename__ = "workflow_runs"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    project_id: uuid.UUID = Field(foreign_key="projects.id")
    plan_id: Optional[uuid.UUID] = Field(default=None, foreign_key="plans.id")
    task_id: Optional[uuid.UUID] = Field(default=None, foreign_key="tasks.id")
    workflow_type: str = Field(sa_type=Text)
    status: str = Field(default="created", sa_type=Text)
    correlation_id: uuid.UUID = Field(default_factory=uuid.uuid4)
    idempotency_key: Optional[str] = Field(default=None, sa_type=Text)
    initiated_by: str = Field(sa_type=Text)
    input_payload: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    output_payload: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    started_at: Optional[datetime] = Field(default=None, sa_type=DateTime(timezone=True))
    finished_at: Optional[datetime] = Field(default=None, sa_type=DateTime(timezone=True))
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    updated_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))


class AgentRun(SQLModel, table=True):
    __tablename__ = "agent_runs"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    workflow_run_id: Optional[uuid.UUID] = Field(default=None, foreign_key="workflow_runs.id")
    project_id: uuid.UUID = Field(foreign_key="projects.id")
    plan_id: Optional[uuid.UUID] = Field(default=None, foreign_key="plans.id")
    task_id: Optional[uuid.UUID] = Field(default=None, foreign_key="tasks.id")
    agent_definition_id: Optional[uuid.UUID] = Field(default=None, foreign_key="agent_definitions.id")
    model_configuration_id: Optional[uuid.UUID] = Field(default=None, foreign_key="model_configurations.id")
    prompt_version_id: Optional[uuid.UUID] = Field(default=None, foreign_key="prompt_versions.id")
    agent_key: str = Field(sa_type=Text)
    model_profile: str = Field(sa_type=Text)
    status: str = Field(default="queued", sa_type=Text)
    correlation_id: uuid.UUID
    input_payload: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    output_payload: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    error_code: Optional[str] = Field(default=None, sa_type=Text)
    error_message: Optional[str] = Field(default=None, sa_type=Text)
    started_at: Optional[datetime] = Field(default=None, sa_type=DateTime(timezone=True))
    finished_at: Optional[datetime] = Field(default=None, sa_type=DateTime(timezone=True))
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    updated_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))


class ModelCall(SQLModel, table=True):
    __tablename__ = "model_calls"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    agent_run_id: uuid.UUID = Field(foreign_key="agent_runs.id")
    model_configuration_id: Optional[uuid.UUID] = Field(default=None, foreign_key="model_configurations.id")
    provider_key: str = Field(sa_type=Text)
    provider_model_name: str = Field(sa_type=Text)
    provider_request_id: Optional[str] = Field(default=None, sa_type=Text)
    status: str = Field(sa_type=Text)
    input_tokens: Optional[int] = Field(default=None, sa_type=Integer)
    output_tokens: Optional[int] = Field(default=None, sa_type=Integer)
    estimated_cost_usd: Optional[float] = Field(default=None, sa_type=Numeric(12, 6))
    latency_ms: Optional[int] = Field(default=None, sa_type=Integer)
    error_code: Optional[str] = Field(default=None, sa_type=Text)
    error_message: Optional[str] = Field(default=None, sa_type=Text)
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))


class TaskClassification(SQLModel, table=True):
    __tablename__ = "task_classifications"

    task_id: uuid.UUID = Field(foreign_key="tasks.id", primary_key=True)
    task_class: str = Field(sa_type=Text)
    risk_level: str = Field(sa_type=Text)
    sensitivity_flags: List[str] = Field(default_factory=list, sa_column=Column(JSON))
    confidence_inputs: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    updated_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))


class AutonomyDecision(SQLModel, table=True):
    __tablename__ = "autonomy_decisions"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    project_id: uuid.UUID = Field(foreign_key="projects.id")
    task_id: uuid.UUID = Field(foreign_key="tasks.id")
    related_run_id: Optional[uuid.UUID] = Field(default=None, foreign_key="execution_runs.id")
    autonomy_mode: str = Field(sa_type=Text)
    approval_required: bool = Field(default=False, sa_type=Boolean)
    review_required: bool = Field(default=False, sa_type=Boolean)
    confidence_score: float = Field(sa_type=Numeric(5, 4))
    escalation_reason: Optional[str] = Field(default=None, sa_type=Text)
    allowed_actions: List[str] = Field(default_factory=list, sa_column=Column(JSON))
    sensitive_scope_flags: List[str] = Field(default_factory=list, sa_column=Column(JSON))
    decision_summary: str = Field(sa_type=Text)
    evidence_payload: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))


class ExecutionContract(SQLModel, table=True):
    __tablename__ = "execution_contracts"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    task_id: uuid.UUID = Field(foreign_key="tasks.id")
    autonomy_decision_id: uuid.UUID = Field(foreign_key="autonomy_decisions.id")
    execution_mode: str = Field(sa_type=Text)
    allowed_actions: List[str] = Field(default_factory=list, sa_column=Column(JSON))
    retry_limit: int = Field(default=0, sa_type=Integer)
    branch_policy: str = Field(sa_type=Text)
    write_permission: str = Field(sa_type=Text)
    approval_state: str = Field(default="not_required", sa_type=Text)
    expires_at: Optional[datetime] = Field(default=None, sa_type=DateTime(timezone=True))
    issued_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))


class JiraIssueMapping(SQLModel, table=True):
    __tablename__ = "jira_issue_mappings"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    task_id: uuid.UUID = Field(foreign_key="tasks.id")
    project_id: uuid.UUID = Field(foreign_key="projects.id")
    sync_status: str = Field(default="pending", sa_type=Text)
    external_issue_key: Optional[str] = Field(default=None, sa_type=Text)
    external_issue_url: Optional[str] = Field(default=None, sa_type=Text)
    idempotency_key: str = Field(sa_type=Text)
    request_payload: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    error_message: Optional[str] = Field(default=None, sa_type=Text)
    attempt_count: int = Field(default=0, sa_type=Integer)
    last_attempt_at: Optional[datetime] = Field(default=None, sa_type=DateTime(timezone=True))
    synchronized_at: Optional[datetime] = Field(default=None, sa_type=DateTime(timezone=True))
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    updated_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
