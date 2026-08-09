import uuid
from typing import Optional, Dict, Any, List
from datetime import datetime, timezone
from sqlmodel import Field, SQLModel, Column, JSON, Integer, Text, DateTime

def utcnow():
    return datetime.now(timezone.utc)

class Project(SQLModel, table=True):
    __tablename__ = "projects"
    
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    name: str = Field(sa_type=Text)
    description: Optional[str] = Field(default=None, sa_type=Text)
    status: str = Field(default="draft", sa_type=Text)
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    updated_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))

class ProjectRequirement(SQLModel, table=True):
    __tablename__ = "project_requirements"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    project_id: uuid.UUID = Field(foreign_key="projects.id")
    position: int = Field(sa_type=Integer)
    requirement_text: str = Field(sa_type=Text)
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    updated_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))

class Plan(SQLModel, table=True):
    __tablename__ = "plans"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    project_id: uuid.UUID = Field(foreign_key="projects.id")
    version: int = Field(sa_type=Integer)
    title: str = Field(sa_type=Text)
    summary: Optional[str] = Field(default=None, sa_type=Text)
    status: str = Field(default="draft", sa_type=Text)
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    updated_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))

class Task(SQLModel, table=True):
    __tablename__ = "tasks"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    plan_id: uuid.UUID = Field(foreign_key="plans.id")
    position: int = Field(sa_type=Integer)
    task_type: str = Field(default="generic", sa_type=Text)
    title: str = Field(sa_type=Text)
    instructions: str = Field(sa_type=Text)
    status: str = Field(default="pending", sa_type=Text)
    input_payload: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    updated_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))

class TaskDependency(SQLModel, table=True):
    __tablename__ = "task_dependencies"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    task_id: uuid.UUID = Field(foreign_key="tasks.id")
    depends_on_task_id: uuid.UUID = Field(foreign_key="tasks.id")
    dependency_type: str = Field(default="blocks", sa_type=Text)
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))

class TaskRelationship(SQLModel, table=True):
    __tablename__ = "task_links"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    parent_task_id: uuid.UUID = Field(foreign_key="tasks.id")
    child_task_id: uuid.UUID = Field(foreign_key="tasks.id")
    relationship_type: str = Field(default="follow_up", sa_column=Column("link_type", Text))
    relationship_metadata: Dict[str, Any] = Field(default_factory=dict, sa_column=Column("metadata", JSON))
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    updated_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))

class TaskLoop(SQLModel, table=True):
    __tablename__ = "task_loops"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    task_id: uuid.UUID = Field(foreign_key="tasks.id")
    status: str = Field(default="idle", sa_type=Text)
    current_action: Optional[str] = Field(default=None, sa_type=Text)
    retry_count: int = Field(default=0, sa_type=Integer)
    consecutive_failures: int = Field(default=0, sa_type=Integer)
    chain_depth: int = Field(default=0, sa_type=Integer)
    follow_up_count: int = Field(default=0, sa_type=Integer)
    last_result_status: Optional[str] = Field(default=None, sa_type=Text)
    last_bug_category: Optional[str] = Field(default=None, sa_type=Text)
    last_failure_pattern: Optional[str] = Field(default=None, sa_type=Text)
    last_task_session_id: Optional[uuid.UUID] = Field(default=None, foreign_key="task_sessions.id")
    last_run_id: Optional[uuid.UUID] = Field(default=None, foreign_key="execution_runs.id")
    loop_started_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    last_transition_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    timeout_at: Optional[datetime] = Field(default=None, sa_type=DateTime(timezone=True))
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    updated_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))

class TaskLoopHistory(SQLModel, table=True):
    __tablename__ = "task_history"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    task_loop_id: Optional[uuid.UUID] = Field(default=None, foreign_key="task_loops.id")
    task_id: uuid.UUID = Field(foreign_key="tasks.id")
    task_session_id: Optional[uuid.UUID] = Field(default=None, foreign_key="task_sessions.id")
    execution_run_id: Optional[uuid.UUID] = Field(default=None, foreign_key="execution_runs.id")
    action: str = Field(sa_type=Text)
    task_status: Optional[str] = Field(default=None, sa_type=Text)
    result_status: Optional[str] = Field(default=None, sa_type=Text)
    bug_category: Optional[str] = Field(default=None, sa_type=Text)
    failure_pattern_key: Optional[str] = Field(default=None, sa_type=Text)
    retry_count: int = Field(default=0, sa_type=Integer)
    chain_depth: int = Field(default=0, sa_type=Integer)
    summary: Optional[str] = Field(default=None, sa_type=Text)
    payload: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, sa_column=Column("timestamp", DateTime(timezone=True)))

class Approval(SQLModel, table=True):
    __tablename__ = "approvals"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    plan_id: uuid.UUID = Field(foreign_key="plans.id")
    requested_by: str = Field(sa_type=Text)
    approver: Optional[str] = Field(default=None, sa_type=Text)
    status: str = Field(default="pending", sa_type=Text)
    decision_note: Optional[str] = Field(default=None, sa_type=Text)
    requested_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    decided_at: Optional[datetime] = Field(default=None, sa_type=DateTime(timezone=True))
    expected_plan_updated_at: Optional[datetime] = Field(default=None, sa_type=DateTime(timezone=True))
    idempotency_key: Optional[str] = Field(default=None, sa_type=Text)
    decision_idempotency_key: Optional[str] = Field(default=None, sa_type=Text)
    decision_version: int = Field(default=1, sa_type=Integer)
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    updated_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))

class AutonomyOverride(SQLModel, table=True):
    __tablename__ = "policy_overrides"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    project_id: Optional[uuid.UUID] = Field(default=None, foreign_key="projects.id")
    task_id: Optional[uuid.UUID] = Field(default=None, foreign_key="tasks.id")
    scope: str = Field(default="task", sa_type=Text)
    operator: str = Field(sa_column=Column("created_by", Text))
    reason: Optional[str] = Field(default=None, sa_type=Text)
    status: str = Field(default="active", sa_type=Text)
    force_autonomy_mode: Optional[str] = Field(default=None, sa_type=Text)
    force_review: bool = Field(default=False)
    disable_retries: bool = Field(default=False)
    sensitive_modules: List[str] = Field(default_factory=list, sa_column=Column(JSON))
    policy_adjustments: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    updated_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))

class TaskSession(SQLModel, table=True):
    __tablename__ = "task_sessions"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    task_id: uuid.UUID = Field(foreign_key="tasks.id")
    status: str = Field(default="open", sa_type=Text)
    artifact_path: Optional[str] = Field(default=None, sa_type=Text)
    session_metadata: Dict[str, Any] = Field(default_factory=dict, sa_column=Column("metadata", JSON))
    started_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    ended_at: Optional[datetime] = Field(default=None, sa_type=DateTime(timezone=True))
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    updated_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))

class ExecutionRun(SQLModel, table=True):
    __tablename__ = "execution_runs"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    task_session_id: uuid.UUID = Field(foreign_key="task_sessions.id")
    attempt_no: int = Field(sa_type=Integer)
    status: str = Field(default="queued", sa_type=Text)
    worker_name: Optional[str] = Field(default=None, sa_type=Text)
    artifact_path: Optional[str] = Field(default=None, sa_type=Text)
    input_payload: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    output_payload: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    error_message: Optional[str] = Field(default=None, sa_type=Text)
    started_at: Optional[datetime] = Field(default=None, sa_type=DateTime(timezone=True))
    finished_at: Optional[datetime] = Field(default=None, sa_type=DateTime(timezone=True))
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    updated_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))

class Event(SQLModel, table=True):
    __tablename__ = "events"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    project_id: Optional[uuid.UUID] = Field(default=None, foreign_key="projects.id")
    plan_id: Optional[uuid.UUID] = Field(default=None, foreign_key="plans.id")
    task_id: Optional[uuid.UUID] = Field(default=None, foreign_key="tasks.id")
    task_session_id: Optional[uuid.UUID] = Field(default=None, foreign_key="task_sessions.id")
    execution_run_id: Optional[uuid.UUID] = Field(default=None, foreign_key="execution_runs.id")
    event_source: str = Field(sa_type=Text)
    event_type: str = Field(sa_type=Text)
    artifact_path: Optional[str] = Field(default=None, sa_type=Text)
    payload: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    occurred_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
