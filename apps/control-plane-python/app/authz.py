"""Small backend authorization boundary until an upstream identity provider is wired."""

import os

from fastapi import Header, HTTPException


def approval_actor(x_osai_actor: str | None = Header(default=None)) -> str:
    actor = (x_osai_actor or os.getenv("CONTROL_PLANE_APPROVER", "")).strip()
    if not actor:
        raise HTTPException(status_code=401, detail="An approval actor is required.")

    allowed = {
        value.strip()
        for value in os.getenv("OSAI_APPROVER_ACTORS", "").split(",")
        if value.strip()
    }
    environment = os.getenv("OSAI_ENV", "development").strip().lower()
    if environment in {"production", "prod"} and not allowed:
        raise HTTPException(status_code=503, detail="OSAI_APPROVER_ACTORS must be configured in production.")
    if allowed and actor not in allowed:
        raise HTTPException(status_code=403, detail="Actor is not authorized to decide approvals.")
    return actor
