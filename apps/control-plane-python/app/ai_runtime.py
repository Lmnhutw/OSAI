"""Minimal, audited boundary for OpenAI-compatible model calls.

Business services choose one of three logical profiles; credentials are loaded
only from environment variables and never become database or API payloads.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Literal, Mapping, TypeVar
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pydantic import BaseModel

ModelProfile = Literal["reasoning", "execution", "review"]
MODEL_PROFILES: tuple[ModelProfile, ...] = ("reasoning", "execution", "review")
T = TypeVar("T", bound=BaseModel)
Transport = Callable[[str, Mapping[str, str], Mapping[str, Any], float], Mapping[str, Any]]


class ModelRuntimeError(RuntimeError):
    """A safe, operator-facing model configuration or provider failure."""


@dataclass(frozen=True)
class ModelSettings:
    profile: ModelProfile
    provider: str
    model: str
    base_url: str
    api_key: str
    timeout_seconds: float
    temperature: float
    max_output_tokens: int

    @classmethod
    def from_environment(cls, profile: ModelProfile, environ: Mapping[str, str] | None = None) -> "ModelSettings":
        if profile not in MODEL_PROFILES:
            raise ModelRuntimeError(f"Unsupported model profile: {profile}")
        values = os.environ if environ is None else environ
        prefix = f"OSAI_{profile.upper()}_"
        provider = values.get(f"{prefix}PROVIDER", "openai_compatible").strip().lower()
        environment = values.get("OSAI_ENV", "development").strip().lower()
        if provider == "test" and environment in {"production", "prod"}:
            raise ModelRuntimeError("The test model provider is forbidden in production.")
        if provider not in {"openai_compatible", "test"}:
            raise ModelRuntimeError(f"Provider '{provider}' is not implemented by this runtime.")

        model = values.get(f"{prefix}MODEL", "").strip()
        api_key = values.get(f"{prefix}API_KEY", "").strip()
        base_url = values.get(f"{prefix}BASE_URL", "").strip().rstrip("/")
        if not model:
            raise ModelRuntimeError(f"{prefix}MODEL is required for the {profile} profile.")
        if provider == "openai_compatible" and (not api_key or not base_url):
            raise ModelRuntimeError(f"{prefix}API_KEY and {prefix}BASE_URL are required for the {profile} profile.")

        try:
            timeout_seconds = float(values.get(f"{prefix}TIMEOUT_SECONDS", "60"))
            temperature = float(values.get(f"{prefix}TEMPERATURE", "0.2"))
            max_output_tokens = int(values.get(f"{prefix}MAX_OUTPUT_TOKENS", "4096"))
        except ValueError as exc:
            raise ModelRuntimeError(f"Invalid numeric configuration for the {profile} profile.") from exc
        if timeout_seconds <= 0 or not 0 <= temperature <= 2 or max_output_tokens <= 0:
            raise ModelRuntimeError(f"Invalid limits for the {profile} profile.")

        return cls(profile, provider, model, base_url, api_key, timeout_seconds, temperature, max_output_tokens)


@dataclass(frozen=True)
class ModelCallMetadata:
    profile: ModelProfile
    provider: str
    model: str
    provider_request_id: str | None
    input_tokens: int | None
    output_tokens: int | None
    latency_ms: int


def _urllib_transport(url: str, headers: Mapping[str, str], payload: Mapping[str, Any], timeout: float) -> Mapping[str, Any]:
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={**headers, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:  # noqa: S310 - configured HTTPS endpoint
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise ModelRuntimeError(f"Model provider returned HTTP {exc.code}.") from exc
    except URLError as exc:
        raise ModelRuntimeError("Model provider is unreachable.") from exc


class ModelRuntime:
    def __init__(self, transport: Transport | None = None):
        self._transport = transport or _urllib_transport

    def invoke_json(
        self,
        profile: ModelProfile,
        *,
        system_prompt: str,
        user_prompt: str,
        response_model: type[T],
        environ: Mapping[str, str] | None = None,
    ) -> tuple[T, ModelCallMetadata]:
        settings = ModelSettings.from_environment(profile, environ)
        if settings.provider != "openai_compatible":
            raise ModelRuntimeError("The test provider requires an injected OpenAI-compatible transport.")

        started = time.monotonic()
        payload = {
            "model": settings.model,
            "temperature": settings.temperature,
            "max_tokens": settings.max_output_tokens,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "response_format": {"type": "json_object"},
        }
        response = self._transport(
            f"{settings.base_url}/chat/completions",
            {"Authorization": f"Bearer {settings.api_key}"},
            payload,
            settings.timeout_seconds,
        )
        latency_ms = round((time.monotonic() - started) * 1000)
        try:
            content = response["choices"][0]["message"]["content"]
            decoded = json.loads(content) if isinstance(content, str) else content
            result = response_model.model_validate(decoded)
        except (IndexError, KeyError, TypeError, json.JSONDecodeError, ValueError) as exc:
            raise ModelRuntimeError("Model provider returned output that does not match the required JSON schema.") from exc

        usage = response.get("usage") or {}
        metadata = ModelCallMetadata(
            profile=settings.profile,
            provider=settings.provider,
            model=settings.model,
            provider_request_id=response.get("id"),
            input_tokens=usage.get("prompt_tokens"),
            output_tokens=usage.get("completion_tokens"),
            latency_ms=latency_ms,
        )
        return result, metadata
