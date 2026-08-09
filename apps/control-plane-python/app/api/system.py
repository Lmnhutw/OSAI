from typing import List, Optional
import uuid

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from ..ai_models import AgentRun
from ..ai_runtime import MODEL_PROFILES, ModelRuntimeError, ModelSettings
from ..database import get_session
from ..schemas import AgentRunRead, ModelProfileStatusRead

router = APIRouter(prefix="/system", tags=["system"])


@router.get("/models", response_model=List[ModelProfileStatusRead])
def get_model_profiles():
    profiles: List[ModelProfileStatusRead] = []
    for profile in MODEL_PROFILES:
        try:
            settings = ModelSettings.from_environment(profile)
            profiles.append(
                ModelProfileStatusRead(
                    profile=profile,
                    configured=True,
                    provider=settings.provider,
                    model=settings.model,
                    base_url=settings.base_url or None,
                )
            )
        except ModelRuntimeError as exc:
            profiles.append(ModelProfileStatusRead(profile=profile, configured=False, error=str(exc)))
    return profiles


@router.get("/agent-runs", response_model=List[AgentRunRead])
def list_agent_runs(
    project_id: Optional[uuid.UUID] = None,
    task_id: Optional[uuid.UUID] = None,
    limit: int = 50,
    session: Session = Depends(get_session),
):
    statement = select(AgentRun)
    if project_id:
        statement = statement.where(AgentRun.project_id == project_id)
    if task_id:
        statement = statement.where(AgentRun.task_id == task_id)
    return session.exec(statement.order_by(AgentRun.created_at.desc()).limit(min(max(limit, 1), 200))).all()
