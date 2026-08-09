-- Reconcile ORM names with the canonical Phase 4 tables without breaking the
-- existing Python API contracts during the transition.

ALTER TABLE task_links
    ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT NOW();

ALTER TABLE task_links DROP CONSTRAINT chk_task_links_type;
ALTER TABLE task_links ADD CONSTRAINT chk_task_links_type CHECK (
    link_type IN ('follow_up', 'dependency', 'retry', 'bugfix', 'chain')
);
DROP TRIGGER IF EXISTS trg_task_links_set_updated_at ON task_links;
CREATE TRIGGER trg_task_links_set_updated_at BEFORE UPDATE ON task_links FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The Python loop controller has always owned this concept, while older SQL
-- snapshots only persisted its history. Make the active loop authoritative.
CREATE TABLE IF NOT EXISTS task_loops (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'idle',
    current_action text,
    retry_count integer NOT NULL DEFAULT 0,
    consecutive_failures integer NOT NULL DEFAULT 0,
    chain_depth integer NOT NULL DEFAULT 0,
    follow_up_count integer NOT NULL DEFAULT 0,
    last_result_status text,
    last_bug_category text,
    last_failure_pattern text,
    last_task_session_id uuid REFERENCES task_sessions(id) ON DELETE SET NULL,
    last_run_id uuid REFERENCES execution_runs(id) ON DELETE SET NULL,
    loop_started_at timestamptz NOT NULL DEFAULT NOW(),
    last_transition_at timestamptz NOT NULL DEFAULT NOW(),
    timeout_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_task_loops_counts CHECK (
        retry_count >= 0 AND consecutive_failures >= 0 AND chain_depth >= 0 AND follow_up_count >= 0
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_loops_one_active_per_task
    ON task_loops (task_id)
    WHERE status NOT IN ('completed', 'cancelled', 'failed');
CREATE INDEX IF NOT EXISTS idx_task_loops_task_updated_at
    ON task_loops (task_id, updated_at DESC);
DROP TRIGGER IF EXISTS trg_task_loops_set_updated_at ON task_loops;
CREATE TRIGGER trg_task_loops_set_updated_at BEFORE UPDATE ON task_loops FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE task_history
    ALTER COLUMN state SET DEFAULT 'recorded',
    ADD COLUMN IF NOT EXISTS task_loop_id uuid REFERENCES task_loops(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS task_session_id uuid REFERENCES task_sessions(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS execution_run_id uuid REFERENCES execution_runs(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS action text,
    ADD COLUMN IF NOT EXISTS task_status text,
    ADD COLUMN IF NOT EXISTS result_status text,
    ADD COLUMN IF NOT EXISTS bug_category text,
    ADD COLUMN IF NOT EXISTS failure_pattern_key text,
    ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS chain_depth integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS summary text,
    ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_task_history_task_loop_created_at
    ON task_history (task_loop_id, "timestamp" DESC)
    WHERE task_loop_id IS NOT NULL;

ALTER TABLE policy_overrides
    ALTER COLUMN override_type SET DEFAULT 'autonomy_override',
    ADD COLUMN IF NOT EXISTS scope text,
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS force_autonomy_mode text,
    ADD COLUMN IF NOT EXISTS force_review boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS disable_retries boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS sensitive_modules jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS policy_adjustments jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT NOW();

UPDATE policy_overrides
SET scope = CASE WHEN task_id IS NULL THEN 'project' ELSE 'task' END
WHERE scope IS NULL;
ALTER TABLE policy_overrides ALTER COLUMN scope SET NOT NULL;
ALTER TABLE policy_overrides
    DROP CONSTRAINT IF EXISTS chk_policy_overrides_scope,
    DROP CONSTRAINT IF EXISTS chk_policy_overrides_sensitive_modules_is_array,
    DROP CONSTRAINT IF EXISTS chk_policy_overrides_policy_adjustments_is_object;
ALTER TABLE policy_overrides
    ADD CONSTRAINT chk_policy_overrides_scope CHECK (scope IN ('project', 'task')),
    ADD CONSTRAINT chk_policy_overrides_sensitive_modules_is_array CHECK (jsonb_typeof(sensitive_modules) = 'array'),
    ADD CONSTRAINT chk_policy_overrides_policy_adjustments_is_object CHECK (jsonb_typeof(policy_adjustments) = 'object');
DROP TRIGGER IF EXISTS trg_policy_overrides_set_updated_at ON policy_overrides;
CREATE TRIGGER trg_policy_overrides_set_updated_at BEFORE UPDATE ON policy_overrides FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_policy_overrides_project_status_created_at
    ON policy_overrides (project_id, status, created_at DESC);
