from fastapi import FastAPI, HTTPException, Response
from sqlalchemy import text
from app.api import approvals, memory, operator, plans, projects, runs, search, sessions, system, tasks
from app.database import get_engine
from app.observability import metrics, observe_request

app = FastAPI(
    title="Python Control Plane API",
    description="API for orchestrating the AI Control Plane, generating tasks, and handling approvals.",
    version="1.0.0"
)

app.middleware("http")(observe_request)

app.include_router(projects.router)
app.include_router(plans.router)
app.include_router(tasks.router)
app.include_router(sessions.router)
app.include_router(runs.router)
app.include_router(memory.router)
app.include_router(approvals.router)
app.include_router(operator.router)
app.include_router(search.router)
app.include_router(system.router)

@app.get("/health")
def health_check():
    return {"status": "healthy"}


@app.get("/health/live")
def liveness_check():
    return {"status": "healthy"}


@app.get("/health/ready")
def readiness_check():
    try:
        with get_engine().connect() as connection:
            connection.execute(text("SELECT 1"))
    except Exception as exc:
        raise HTTPException(status_code=503, detail="database is unavailable") from exc
    return {"status": "ready"}


@app.get("/metrics", include_in_schema=False)
def prometheus_metrics():
    return Response(content=metrics.render(), media_type="text/plain; version=0.0.4; charset=utf-8")
