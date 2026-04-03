-- Extend Phase 1 schema with memory curation, evaluation tracking,
-- and richer execution-run metadata.
-- Keep this file aligned with db/schema/schema.sql.

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

ALTER TABLE execution_runs
    ADD COLUMN failure_type text,
    ADD COLUMN retry_count integer NOT NULL DEFAULT 0,
    ADD COLUMN confidence_score numeric(5,4),
    ADD CONSTRAINT chk_execution_runs_retry_count CHECK (retry_count >= 0),
    ADD CONSTRAINT chk_execution_runs_confidence_score CHECK (
        confidence_score IS NULL
        OR (confidence_score >= 0 AND confidence_score <= 1)
    );

COMMENT ON COLUMN execution_runs.failure_type IS
    'Optional normalized failure classification such as timeout, validation_error, or tool_error.';
COMMENT ON COLUMN execution_runs.retry_count IS
    'Zero-based retry counter. attempt_no stays unchanged for backward compatibility.';
COMMENT ON COLUMN execution_runs.confidence_score IS
    'Optional confidence signal on a 0-1 scale for dispatch or execution quality.';

-- Supports feeds and dashboards that show the most recent runs, including queued runs with no started_at yet.
CREATE INDEX idx_execution_runs_created_at
    ON execution_runs (created_at DESC);

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
