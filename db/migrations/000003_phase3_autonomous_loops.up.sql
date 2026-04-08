-- Extend Phase 2 schema with autonomous loop tracking, task chaining,
-- loop history, and recurring failure patterns.
-- Keep this file aligned with db/schema/schema.sql.

ALTER TABLE execution_runs
    ADD COLUMN last_retry_at timestamptz;

COMMENT ON COLUMN execution_runs.last_retry_at IS
    'Timestamp when this execution attempt was most recently scheduled or launched as a retry.';

CREATE INDEX idx_execution_runs_task_session_created_at
    ON execution_runs (task_session_id, created_at DESC);

CREATE INDEX idx_execution_runs_last_retry_at
    ON execution_runs (last_retry_at DESC)
    WHERE last_retry_at IS NOT NULL;

CREATE TABLE task_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    child_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    link_type text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_task_links_not_self CHECK (parent_task_id <> child_task_id),
    CONSTRAINT chk_task_links_type CHECK (
        link_type IN ('follow_up', 'dependency', 'retry', 'bugfix')
    )
);

COMMENT ON TABLE task_links IS
    'General task-link graph for follow-up, dependency, retry, and bugfix relationships.';
COMMENT ON COLUMN task_links.parent_task_id IS
    'Upstream or source task in the relationship. For dependency links, this is the prerequisite task.';
COMMENT ON COLUMN task_links.child_task_id IS
    'Downstream or derived task in the relationship. For dependency links, this is the blocked task.';
COMMENT ON COLUMN task_links.link_type IS
    'Relationship type: follow_up, dependency, retry, or bugfix.';

CREATE UNIQUE INDEX uq_task_links_parent_child_type
    ON task_links (parent_task_id, child_task_id, link_type);

CREATE INDEX idx_task_links_parent_task_link_type_created_at
    ON task_links (parent_task_id, link_type, created_at DESC);

CREATE INDEX idx_task_links_child_task_link_type_created_at
    ON task_links (child_task_id, link_type, created_at DESC);

INSERT INTO task_links (parent_task_id, child_task_id, link_type, created_at)
SELECT depends_on_task_id, task_id, 'dependency', created_at
FROM task_dependencies
ON CONFLICT (parent_task_id, child_task_id, link_type) DO NOTHING;

CREATE TABLE task_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    state text NOT NULL,
    decision text,
    "timestamp" timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE task_history IS
    'Append-only task loop history capturing state transitions and control-plane decisions over time.';
COMMENT ON COLUMN task_history.task_id IS
    'Task whose loop state changed.';
COMMENT ON COLUMN task_history.state IS
    'Application-managed loop state such as queued, running, waiting, retrying, or failed.';
COMMENT ON COLUMN task_history.decision IS
    'Optional decision or rationale that explains the transition.';
COMMENT ON COLUMN task_history."timestamp" IS
    'Time when the state transition or loop decision was recorded.';

CREATE INDEX idx_task_history_task_timestamp
    ON task_history (task_id, "timestamp" DESC);

CREATE INDEX idx_task_history_timestamp
    ON task_history ("timestamp" DESC);

CREATE TABLE failure_patterns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    signature text NOT NULL,
    frequency integer NOT NULL DEFAULT 1,
    last_seen_at timestamptz NOT NULL DEFAULT NOW(),
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_failure_patterns_frequency CHECK (frequency >= 1)
);

COMMENT ON TABLE failure_patterns IS
    'Aggregated recurring failure signatures at project scope for retry control and diagnostics.';
COMMENT ON COLUMN failure_patterns.project_id IS
    'Project that owns this normalized failure signature.';
COMMENT ON COLUMN failure_patterns.signature IS
    'Normalized signature, hash input, or classifier key used to group similar failures.';
COMMENT ON COLUMN failure_patterns.frequency IS
    'Number of observed occurrences for this failure signature.';
COMMENT ON COLUMN failure_patterns.last_seen_at IS
    'Most recent observation time for this failure signature.';

CREATE UNIQUE INDEX uq_failure_patterns_project_signature
    ON failure_patterns (project_id, signature);

CREATE INDEX idx_failure_patterns_project_last_seen_at
    ON failure_patterns (project_id, last_seen_at DESC);

CREATE TRIGGER trg_failure_patterns_set_updated_at
BEFORE UPDATE ON failure_patterns
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
