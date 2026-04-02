from fastapi import FastAPI
from app.api import projects, plans, tasks

app = FastAPI(
    title="Python Control Plane API",
    description="API for orchestrating the AI Control Plane, generating tasks, and handling approvals.",
    version="1.0.0"
)

app.include_router(projects.router)
app.include_router(plans.router)
app.include_router(tasks.router)

@app.get("/health")
def health_check():
    return {"status": "healthy"}
