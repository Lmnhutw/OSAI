"""Minimal in-process observability for the modular control-plane deployment."""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from collections import Counter, defaultdict
from typing import Awaitable, Callable

from fastapi import Request, Response

logger = logging.getLogger("osai.control_plane")


class HttpMetrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._requests: Counter[tuple[str, str, int]] = Counter()
        self._latency_ms: defaultdict[tuple[str, str], float] = defaultdict(float)

    def record(self, method: str, route: str, status: int, duration_ms: float) -> None:
        with self._lock:
            self._requests[(method, route, status)] += 1
            self._latency_ms[(method, route)] += duration_ms

    def render(self) -> str:
        with self._lock:
            request_lines = ["# HELP osai_http_requests_total Completed HTTP requests.", "# TYPE osai_http_requests_total counter"]
            for (method, route, status), count in sorted(self._requests.items()):
                request_lines.append(
                    f'osai_http_requests_total{{method="{method}",route="{route}",status="{status}"}} {count}'
                )
            latency_lines = ["# HELP osai_http_request_duration_ms_total Total HTTP request latency in milliseconds.", "# TYPE osai_http_request_duration_ms_total counter"]
            for (method, route), duration in sorted(self._latency_ms.items()):
                latency_lines.append(
                    f'osai_http_request_duration_ms_total{{method="{method}",route="{route}"}} {duration:.3f}'
                )
        return "\n".join([*request_lines, *latency_lines, ""])


metrics = HttpMetrics()


async def observe_request(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    request_id = (request.headers.get("X-Request-ID") or str(uuid.uuid4()))[:128]
    started = time.perf_counter()
    response = await call_next(request)
    duration_ms = (time.perf_counter() - started) * 1000
    route = getattr(request.scope.get("route"), "path", request.url.path)
    metrics.record(request.method, route, response.status_code, duration_ms)
    response.headers["X-Request-ID"] = request_id
    logger.info(
        json.dumps(
            {
                "event": "http.request.completed",
                "request_id": request_id,
                "method": request.method,
                "route": route,
                "status": response.status_code,
                "duration_ms": round(duration_ms, 3),
            },
            separators=(",", ":"),
        )
    )
    return response
