-- Phase 2 PostgreSQL schema for the orchestration system.
-- This file is a full schema snapshot and is intentionally language-agnostic:
-- no ORM assumptions, UUID primary keys, plain SQL constraints, and JSONB only
-- where flexible payloads are useful to both Python and Go services.
--
-- Relationship summary:
--   projects -> project_requirements
--   projects -> memory_items
--   projects -> plans -> tasks -> task_sessions -> execution_runs
--   task_sessions -> task_session_memory_links -> memory_items
--   tasks/task_sessions/execution_runs -> evaluation_results
--   tasks -> task_dependencies (self-referential dependency graph)
--   plans -> approvals
--   events can point at project, plan, task, task_session, and/or execution_run
--
-- Notes:
--   * gen_random_uuid() requires pgcrypto, enabled below.
--   * status columns are TEXT on purpose to keep rollouts simple in Phase 1.
--   * artifact_path is stored on task_sessions, execution_runs, and events for logs.
--   * memory_items adds a lightweight full-text retrieval path for curated knowledge.

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

-- Root entity. A project owns requirements and plans.
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

-- Ordered requirements captured for a project. Each row belongs to one project.
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

-- A plan is a versioned orchestration proposal for a project.
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

-- Tasks are the executable units within a plan.
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

-- Dependency graph for tasks. A task cannot start until its dependency is satisfied.
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

-- Phase 1 approvals are scoped to plans.
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

-- Curated knowledge for a project. Phase 2 stores reusable decisions, constraints,
-- bug patterns, and lessons as first-class rows instead of burying them in run logs.
CREATE TABLE memory_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    memory_type text NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    detail text,
    tags jsonb NOT NULL DEFAULT '[]'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_memory_items_tags_is_array CHECK (jsonb_typeof(tags) = 'array')
);

COMMENT ON TABLE memory_items IS
    'Curated project memory such as decisions, constraints, bug patterns, and lessons.';
COMMENT ON COLUMN memory_items.project_id IS
    'Direct project scope for retrieval without traversing plan, task, and session joins.';
COMMENT ON COLUMN memory_items.memory_type IS
    'Application-managed category such as decision, constraint, bug_pattern, or lesson.';
COMMENT ON COLUMN memory_items.tags IS
    'Optional retrieval tags stored as a JSON array.';

CREATE INDEX idx_memory_items_project_memory_type_updated_at
    ON memory_items (project_id, memory_type, updated_at DESC);

-- Full-text support gives Phase 2 a lightweight retrieval path before embeddings exist.
CREATE INDEX idx_memory_items_search
    ON memory_items
    USING GIN (
        to_tsvector(
            'simple',
            coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(detail, '')
        )
    );

CREATE TRIGGER trg_memory_items_set_updated_at
BEFORE UPDATE ON memory_items
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- A task session groups one logical execution thread for a task.
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

-- Link sessions to reusable memory so a future retrieval layer can trace why a
-- decision or lesson exists and which execution history produced or validated it.
CREATE TABLE task_session_memory_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_session_id uuid NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
    memory_item_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
    relationship_type text NOT NULL DEFAULT 'source',
    summary text,
    created_at timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE task_session_memory_links IS
    'Links task sessions to curated memory items. summary can store the extraction note or task-summary rationale.';
COMMENT ON COLUMN task_session_memory_links.relationship_type IS
    'Application-managed relation such as source, reused_context, or validated_by.';

CREATE UNIQUE INDEX uq_task_session_memory_links_session_memory
    ON task_session_memory_links (task_session_id, memory_item_id);

CREATE INDEX idx_task_session_memory_links_memory_item_id
    ON task_session_memory_links (memory_item_id);

-- One execution attempt inside a task session. Retries create new rows.
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
    failure_type text,
    retry_count integer NOT NULL DEFAULT 0,
    confidence_score numeric(5,4),
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_execution_runs_attempt_no CHECK (attempt_no >= 1),
    CONSTRAINT chk_execution_runs_retry_count CHECK (retry_count >= 0),
    CONSTRAINT chk_execution_runs_confidence_score CHECK (
        confidence_score IS NULL
        OR (confidence_score >= 0 AND confidence_score <= 1)
    ),
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
COMMENT ON COLUMN execution_runs.failure_type IS
    'Optional normalized failure classification such as timeout, validation_error, or tool_error.';
COMMENT ON COLUMN execution_runs.retry_count IS
    'Zero-based retry counter. attempt_no stays unchanged for backward compatibility.';
COMMENT ON COLUMN execution_runs.confidence_score IS
    'Optional confidence signal on a 0-1 scale for dispatch or execution quality.';

CREATE UNIQUE INDEX uq_execution_runs_session_attempt
    ON execution_runs (task_session_id, attempt_no);

CREATE INDEX idx_execution_runs_session_status_created_at
    ON execution_runs (task_session_id, status, created_at DESC);

-- Supports feeds and dashboards that show the most recent runs, including queued runs with no started_at yet.
CREATE INDEX idx_execution_runs_created_at
    ON execution_runs (created_at DESC);

CREATE INDEX idx_execution_runs_started_at
    ON execution_runs (started_at DESC);

CREATE TRIGGER trg_execution_runs_set_updated_at
BEFORE UPDATE ON execution_runs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Flexible evaluation log for dispatching, result review, reviewer feedback, and QA.
-- project_id is stored directly so project dashboards do not need to re-join the full
-- execution tree every time they fetch recent evaluations.
CREATE TABLE evaluation_results (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
    task_session_id uuid REFERENCES task_sessions(id) ON DELETE CASCADE,
    execution_run_id uuid REFERENCES execution_runs(id) ON DELETE CASCADE,
    evaluation_type text NOT NULL,
    evaluator_name text,
    status text NOT NULL DEFAULT 'recorded',
    score numeric(5,4),
    confidence_score numeric(5,4),
    summary text,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_evaluation_results_has_scope CHECK (
        num_nonnulls(task_id, task_session_id, execution_run_id) >= 1
    ),
    CONSTRAINT chk_evaluation_results_score CHECK (
        score IS NULL OR (score >= 0 AND score <= 1)
    ),
    CONSTRAINT chk_evaluation_results_confidence_score CHECK (
        confidence_score IS NULL
        OR (confidence_score >= 0 AND confidence_score <= 1)
    )
);

COMMENT ON TABLE evaluation_results IS
    'Structured evaluation records for dispatch evaluation, result evaluation, reviewer output, and QA output.';
COMMENT ON COLUMN evaluation_results.project_id IS
    'Direct project scope for efficient project-based evaluation queries.';
COMMENT ON COLUMN evaluation_results.evaluation_type IS
    'Application-managed type such as dispatch_eval, result_eval, reviewer_output, or qa_output.';
COMMENT ON COLUMN evaluation_results.details IS
    'Flexible structured payload for rubric results, citations, or reviewer notes.';

CREATE INDEX idx_evaluation_results_project_type_created_at
    ON evaluation_results (project_id, evaluation_type, created_at DESC);

CREATE INDEX idx_evaluation_results_task_session_type_created_at
    ON evaluation_results (task_session_id, evaluation_type, created_at DESC)
    WHERE task_session_id IS NOT NULL;

CREATE INDEX idx_evaluation_results_execution_run_type_created_at
    ON evaluation_results (execution_run_id, evaluation_type, created_at DESC)
    WHERE execution_run_id IS NOT NULL;

CREATE TRIGGER trg_evaluation_results_set_updated_at
BEFORE UPDATE ON evaluation_results
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Append-only event stream for project, plan, task, session, and run lifecycle changes.
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
