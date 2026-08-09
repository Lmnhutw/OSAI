"""Persisted agent execution boundary shared by model-backed control-plane agents."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping, TypeVar

from pydantic import BaseModel
from sqlmodel import Session, select

from ..ai_models import AgentDefinition, AgentRun, ModelCall, ModelConfiguration, ModelProvider, PromptVersion
from ..ai_runtime import MODEL_PROFILES, ModelCallMetadata, ModelRuntime, ModelRuntimeError, ModelProfile, ModelSettings

T = TypeVar("T", bound=BaseModel)


@dataclass(frozen=True)
class AgentSpec:
    agent_key: str
    display_name: str
    model_profile: ModelProfile
    approval_policy: str
    system_prompt: str


AGENT_SPECS: dict[str, AgentSpec] = {
    "planner": AgentSpec(
        "planner",
        "Planner Agent",
        "reasoning",
        "approval_required",
        "Create a concise, execution-ready project plan. Return only valid JSON matching the requested schema.",
    ),
    "project_manager": AgentSpec(
        "project_manager",
        "Project Manager Agent",
        "reasoning",
        "approval_required",
        "Decompose the approved plan into independently executable tasks. Return only valid JSON matching the requested schema.",
    ),
    "reviewer": AgentSpec(
        "reviewer",
        "Reviewer Agent",
        "review",
        "approval_required",
        "Review the provided evidence against the acceptance criteria. Return only valid JSON matching the requested schema.",
    ),
    "qa": AgentSpec(
        "qa",
        "QA Agent",
        "review",
        "approval_required",
        "Assess validation evidence and regression risk. Return only valid JSON matching the requested schema.",
    ),
    "execution": AgentSpec(
        "execution",
        "Execution Agent",
        "execution",
        "constrained_auto",
        "Produce only the requested structured execution guidance. Return only valid JSON matching the requested schema.",
    ),
}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _redact(value: Any, secret: str) -> Any:
    if isinstance(value, str):
        return value.replace(secret, "[REDACTED]") if secret else value
    if isinstance(value, list):
        return [_redact(item, secret) for item in value]
    if isinstance(value, dict):
        return {key: _redact(item, secret) for key, item in value.items()}
    return value


def _ensure_catalog(session: Session, spec: AgentSpec, settings: ModelSettings) -> tuple[AgentDefinition, ModelConfiguration, PromptVersion]:
    provider_key = f"environment:{settings.profile}"
    provider = session.exec(select(ModelProvider).where(ModelProvider.provider_key == provider_key)).first()
    if not provider:
        provider = ModelProvider(
            provider_key=provider_key,
            provider_type=settings.provider,
            display_name=f"{settings.profile.title()} environment provider",
            base_url=settings.base_url or None,
            secret_ref=f"env:OSAI_{settings.profile.upper()}_API_KEY",
        )
        session.add(provider)
        session.flush()
    else:
        provider.provider_type = settings.provider
        provider.base_url = settings.base_url or None
        provider.enabled = True

    model_config = session.exec(
        select(ModelConfiguration).where(ModelConfiguration.profile == settings.profile)
    ).first()
    if not model_config:
        model_config = ModelConfiguration(
            profile=settings.profile,
            provider_id=provider.id,
            model_name=settings.model,
            temperature=settings.temperature,
            max_output_tokens=settings.max_output_tokens,
            timeout_seconds=round(settings.timeout_seconds),
        )
        session.add(model_config)
        session.flush()
    else:
        model_config.provider_id = provider.id
        model_config.model_name = settings.model
        model_config.temperature = settings.temperature
        model_config.max_output_tokens = settings.max_output_tokens
        model_config.timeout_seconds = round(settings.timeout_seconds)
        model_config.enabled = True

    checksum = hashlib.sha256(spec.system_prompt.encode("utf-8")).hexdigest()
    prompt = session.exec(
        select(PromptVersion).where(
            PromptVersion.agent_key == spec.agent_key,
            PromptVersion.prompt_checksum == checksum,
        )
    ).first()
    if not prompt:
        latest = session.exec(
            select(PromptVersion)
            .where(PromptVersion.agent_key == spec.agent_key)
            .order_by(PromptVersion.version.desc())
        ).first()
        prompt = PromptVersion(
            agent_key=spec.agent_key,
            version=(latest.version + 1) if latest else 1,
            system_prompt=spec.system_prompt,
            prompt_checksum=checksum,
        )
        session.add(prompt)
        session.flush()

    agent = session.exec(select(AgentDefinition).where(AgentDefinition.agent_key == spec.agent_key)).first()
    if not agent:
        agent = AgentDefinition(
            agent_key=spec.agent_key,
            display_name=spec.display_name,
            model_profile=spec.model_profile,
            active_prompt_version_id=prompt.id,
            approval_policy=spec.approval_policy,
        )
        session.add(agent)
        session.flush()
    else:
        agent.model_profile = spec.model_profile
        agent.active_prompt_version_id = prompt.id
        agent.enabled = True
    return agent, model_config, prompt


def run_structured_agent(
    session: Session,
    *,
    agent_key: str,
    project_id,
    user_prompt: str,
    response_model: type[T],
    plan_id=None,
    task_id=None,
    correlation_id=None,
    runtime: ModelRuntime | None = None,
    environ: Mapping[str, str] | None = None,
) -> tuple[T, ModelCallMetadata]:
    spec = AGENT_SPECS.get(agent_key)
    if not spec:
        raise ValueError(f"Unknown agent: {agent_key}")
    if spec.model_profile not in MODEL_PROFILES:
        raise ValueError(f"Invalid profile for agent: {agent_key}")

    settings = ModelSettings.from_environment(spec.model_profile, environ)
    agent, model_config, prompt = _ensure_catalog(session, spec, settings)
    run = AgentRun(
        project_id=project_id,
        plan_id=plan_id,
        task_id=task_id,
        agent_definition_id=agent.id,
        model_configuration_id=model_config.id,
        prompt_version_id=prompt.id,
        agent_key=agent_key,
        model_profile=spec.model_profile,
        status="running",
        correlation_id=correlation_id or __import__("uuid").uuid4(),
        input_payload=_redact({"user_prompt": user_prompt}, settings.api_key),
        started_at=_utcnow(),
    )
    session.add(run)
    session.commit()
    session.refresh(run)

    try:
        result, metadata = (runtime or ModelRuntime()).invoke_json(
            spec.model_profile,
            system_prompt=prompt.system_prompt,
            user_prompt=user_prompt,
            response_model=response_model,
            environ=environ,
        )
    except ModelRuntimeError as exc:
        run.status = "failed"
        run.error_code = "model_runtime_error"
        run.error_message = str(exc)
        run.finished_at = _utcnow()
        session.add(
            ModelCall(
                agent_run_id=run.id,
                model_configuration_id=model_config.id,
                provider_key=settings.provider,
                provider_model_name=settings.model,
                status="failed",
                error_code="model_runtime_error",
                error_message=str(exc),
            )
        )
        session.commit()
        raise

    run.status = "succeeded"
    run.output_payload = result.model_dump(mode="json")
    run.finished_at = _utcnow()
    session.add(
        ModelCall(
            agent_run_id=run.id,
            model_configuration_id=model_config.id,
            provider_key=metadata.provider,
            provider_model_name=metadata.model,
            provider_request_id=metadata.provider_request_id,
            status="succeeded",
            input_tokens=metadata.input_tokens,
            output_tokens=metadata.output_tokens,
            latency_ms=metadata.latency_ms,
        )
    )
    session.commit()
    return result, metadata
