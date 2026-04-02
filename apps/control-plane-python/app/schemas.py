from pydantic import BaseModel
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

class BatchTaskApprove(BaseModel):
    task_ids: List[uuid.UUID]
