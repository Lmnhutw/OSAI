# dashboard-nextjs

Phase 1 Next.js dashboard for the orchestration system.

## Scope

- `/projects`
- `/projects/[id]`
- `/plans/[id]`
- `/tasks/[id]`
- `/runs/[id]`

## Environment

Copy `.env.example` and set:

- `CONTROL_PLANE_API_BASE_URL`
- `CONTROL_PLANE_APPROVER`

## Run with Docker Compose

From the repository root:

```bash
docker compose up --build
```

Open the dashboard at <http://localhost:3000>. The API is available at
<http://localhost:8000/health> and PostgreSQL is exposed on port 5432.

The optional execution worker requires Jira credentials and a Codex CLI. Start
it after setting those values in `.env` with:

```bash
docker compose --profile worker up --build
```

## Read endpoint assumptions

The UI is wired against the current Phase 1 schema and expects read endpoints from the control-plane/API layer for:

- `GET /projects`
- `GET /projects/:id`
- `GET /projects/:id/requirements`
- `GET /projects/:id/plans`
- `GET /plans/:id`
- `GET /plans/:id/approvals`
- `GET /plans/:id/tasks`
- `GET /plans/:id/runs`
- `GET /tasks/:id`
- `GET /tasks/:id/dependencies`
- `GET /tasks/:id/sessions`
- `GET /tasks/:id/runs`
- `GET /sessions/:id`
- `GET /sessions/:id/events`
- `GET /runs/:id`
- `GET /runs/:id/events`

Write actions already align to the existing Python control-plane routes:

- `POST /plans/:id/approve`
- `POST /tasks/batch/approve`
