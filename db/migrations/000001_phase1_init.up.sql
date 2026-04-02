-- Bootstrap Phase 1 schema.
-- Keep this file aligned with db/schema/schema.sql.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TABLE projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    description text,
    status text NOT NULL DEFAULT 'draft',
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE projects IS
    'Root entity for orchestration. A project owns many requirements and plans.';
COMMENT ON COLUMN projects.status IS
    'Application-managed lifecycle state such as draft, planning, approved, running, completed, or failed.';

CREATE INDEX idx_projects_status_created_at
    ON projects (status, created_at DESC);

CREATE TRIGGER trg_projects_set_updated_at
BEFORE UPDATE ON projects
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE project_requirements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    position integer NOT NULL,
    requirement_text text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_project_requirements_position CHECK (position >= 1)
);

COMMENT ON TABLE project_requirements IS
    'Requirement rows for a project. The ordered list is scoped by project_id.';
COMMENT ON COLUMN project_requirements.project_id IS
    'Parent project for this requirement row.';

CREATE UNIQUE INDEX uq_project_requirements_project_position
    ON project_requirements (project_id, position);

CREATE INDEX idx_project_requirements_project_created_at
    ON project_requirements (project_id, created_at DESC);

CREATE TRIGGER trg_project_requirements_set_updated_at
BEFORE UPDATE ON project_requirements
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version integer NOT NULL,
    title text NOT NULL,
    summary text,
    status text NOT NULL DEFAULT 'draft',
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_plans_version CHECK (version >= 1)
);

COMMENT ON TABLE plans IS
    'Versioned execution plan for a project. A plan owns tasks and approval records.';
COMMENT ON COLUMN plans.project_id IS
    'Parent project that this plan belongs to.';

CREATE UNIQUE INDEX uq_plans_project_version
    ON plans (project_id, version);

CREATE INDEX idx_plans_project_status_created_at
    ON plans (project_id, status, created_at DESC);

CREATE TRIGGER trg_plans_set_updated_at
BEFORE UPDATE ON plans
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    position integer NOT NULL,
    task_type text NOT NULL DEFAULT 'generic',
    title text NOT NULL,
    instructions text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    input_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_tasks_position CHECK (position >= 1)
);

COMMENT ON TABLE tasks IS
    'Executable units within a plan. Each task may have dependencies and execution sessions.';
COMMENT ON COLUMN tasks.plan_id IS
    'Parent plan that owns this task.';

CREATE UNIQUE INDEX uq_tasks_plan_position
    ON tasks (plan_id, position);

CREATE INDEX idx_tasks_plan_status_position
    ON tasks (plan_id, status, position);

CREATE TRIGGER trg_tasks_set_updated_at
BEFORE UPDATE ON tasks
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE task_dependencies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    dependency_type text NOT NULL DEFAULT 'blocks',
    created_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_task_dependencies_not_self CHECK (task_id <> depends_on_task_id)
);

COMMENT ON TABLE task_dependencies IS
    'Self-referential join table for task ordering. Phase 1 expects both tasks to belong to the same plan; services should enforce that.';
COMMENT ON COLUMN task_dependencies.task_id IS
    'Task that is blocked.';
COMMENT ON COLUMN task_dependencies.depends_on_task_id IS
    'Task that must complete before task_id can proceed.';

CREATE UNIQUE INDEX uq_task_dependencies_task_depends_on
    ON task_dependencies (task_id, depends_on_task_id);

CREATE INDEX idx_task_dependencies_depends_on_task_id
    ON task_dependencies (depends_on_task_id);

CREATE TABLE approvals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    requested_by text NOT NULL,
    approver text,
    status text NOT NULL DEFAULT 'pending',
    decision_note text,
    requested_at timestamptz NOT NULL DEFAULT NOW(),
    decided_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_approvals_decided_at CHECK (
        decided_at IS NULL OR decided_at >= requested_at
    )
);

COMMENT ON TABLE approvals IS
    'Approval records for a plan. Multiple rows allow re-review or resubmission over time.';
COMMENT ON COLUMN approvals.plan_id IS
    'Approved or rejected plan.';

CREATE INDEX idx_approvals_plan_status_requested_at
    ON approvals (plan_id, status, requested_at DESC);

CREATE INDEX idx_approvals_status_requested_at
    ON approvals (status, requested_at DESC);

CREATE TRIGGER trg_approvals_set_updated_at
BEFORE UPDATE ON approvals
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE task_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'open',
    artifact_path text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_at timestamptz NOT NULL DEFAULT NOW(),
    ended_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_task_sessions_ended_at CHECK (
        ended_at IS NULL OR ended_at >= started_at
    )
);

COMMENT ON TABLE task_sessions IS
    'Logical execution session for a task. A session owns one or more execution runs and can store session-level log artifacts.';
COMMENT ON COLUMN task_sessions.task_id IS
    'Task being executed across one or more attempts.';
COMMENT ON COLUMN task_sessions.artifact_path IS
    'Optional path to session-level logs, transcripts, or combined artifacts.';

CREATE INDEX idx_task_sessions_task_status_started_at
    ON task_sessions (task_id, status, started_at DESC);

CREATE INDEX idx_task_sessions_started_at
    ON task_sessions (started_at DESC);

CREATE TRIGGER trg_task_sessions_set_updated_at
BEFORE UPDATE ON task_sessions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE execution_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_session_id uuid NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
    attempt_no integer NOT NULL,
    status text NOT NULL DEFAULT 'queued',
    worker_name text,
    artifact_path text,
    input_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    output_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    error_message text,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_execution_runs_attempt_no CHECK (attempt_no >= 1),
    CONSTRAINT chk_execution_runs_finished_at CHECK (
        finished_at IS NULL
        OR started_at IS NULL
        OR finished_at >= started_at
    )
);

COMMENT ON TABLE execution_runs IS
    'Per-attempt execution records for a task session. artifact_path points to run-specific logs or outputs.';
COMMENT ON COLUMN execution_runs.task_session_id IS
    'Parent task session for this execution attempt.';
COMMENT ON COLUMN execution_runs.artifact_path IS
    'Optional path to per-run logs, stdout/stderr archives, or execution output bundles.';

CREATE UNIQUE INDEX uq_execution_runs_session_attempt
    ON execution_runs (task_session_id, attempt_no);

CREATE INDEX idx_execution_runs_session_status_created_at
    ON execution_runs (task_session_id, status, created_at DESC);

CREATE INDEX idx_execution_runs_started_at
    ON execution_runs (started_at DESC);

CREATE TRIGGER trg_execution_runs_set_updated_at
BEFORE UPDATE ON execution_runs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
    plan_id uuid REFERENCES plans(id) ON DELETE CASCADE,
    task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
    task_session_id uuid REFERENCES task_sessions(id) ON DELETE CASCADE,
    execution_run_id uuid REFERENCES execution_runs(id) ON DELETE CASCADE,
    event_source text NOT NULL,
    event_type text NOT NULL,
    artifact_path text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT NOW(),
    created_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_events_has_scope CHECK (
        num_nonnulls(project_id, plan_id, task_id, task_session_id, execution_run_id) >= 1
    )
);

COMMENT ON TABLE events IS
    'Append-only event journal. An event may be attached at project, plan, task, session, or execution-run scope, with at least one scope reference required.';
COMMENT ON COLUMN events.artifact_path IS
    'Optional path to logs or serialized evidence associated with this specific event.';
COMMENT ON COLUMN events.event_source IS
    'Producer of the event, for example control_plane or execution.';

CREATE INDEX idx_events_project_occurred_at
    ON events (project_id, occurred_at DESC);

CREATE INDEX idx_events_plan_occurred_at
    ON events (plan_id, occurred_at DESC);

CREATE INDEX idx_events_task_occurred_at
    ON events (task_id, occurred_at DESC);

CREATE INDEX idx_events_task_session_occurred_at
    ON events (task_session_id, occurred_at DESC);

CREATE INDEX idx_events_execution_run_occurred_at
    ON events (execution_run_id, occurred_at DESC);

CREATE INDEX idx_events_type_occurred_at
    ON events (event_type, occurred_at DESC);
