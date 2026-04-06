from fastapi import FastAPI
from app.api import memory, plans, projects, runs, sessions, tasks
from app.database import init_db

app = FastAPI(
    title="Python Control Plane API",
    description="API for orchestrating the AI Control Plane, generating tasks, and handling approvals.",
    version="1.0.0"
)

app.include_router(projects.router)
app.include_router(plans.router)
app.include_router(tasks.router)
app.include_router(sessions.router)
app.include_router(runs.router)
app.include_router(memory.router)

@app.on_event("startup")
def startup():
    init_db()

@app.get("/health")
def health_check():
    return {"status": "healthy"}
