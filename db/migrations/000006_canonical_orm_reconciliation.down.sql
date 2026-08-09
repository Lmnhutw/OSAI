DROP INDEX IF EXISTS idx_policy_overrides_project_status_created_at;
DROP TRIGGER IF EXISTS trg_policy_overrides_set_updated_at ON policy_overrides;
ALTER TABLE policy_overrides
    DROP CONSTRAINT IF EXISTS chk_policy_overrides_policy_adjustments_is_object,
    DROP CONSTRAINT IF EXISTS chk_policy_overrides_sensitive_modules_is_array,
    DROP CONSTRAINT IF EXISTS chk_policy_overrides_scope,
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS policy_adjustments,
    DROP COLUMN IF EXISTS sensitive_modules,
    DROP COLUMN IF EXISTS disable_retries,
    DROP COLUMN IF EXISTS force_review,
    DROP COLUMN IF EXISTS force_autonomy_mode,
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS scope;
ALTER TABLE policy_overrides ALTER COLUMN override_type DROP DEFAULT;

DROP INDEX IF EXISTS idx_task_history_task_loop_created_at;
ALTER TABLE task_history
    DROP COLUMN IF EXISTS payload,
    DROP COLUMN IF EXISTS summary,
    DROP COLUMN IF EXISTS chain_depth,
    DROP COLUMN IF EXISTS retry_count,
    DROP COLUMN IF EXISTS failure_pattern_key,
    DROP COLUMN IF EXISTS bug_category,
    DROP COLUMN IF EXISTS result_status,
    DROP COLUMN IF EXISTS task_status,
    DROP COLUMN IF EXISTS action,
    DROP COLUMN IF EXISTS execution_run_id,
    DROP COLUMN IF EXISTS task_session_id,
    DROP COLUMN IF EXISTS task_loop_id;
ALTER TABLE task_history ALTER COLUMN state DROP DEFAULT;

DROP INDEX IF EXISTS idx_task_loops_task_updated_at;
DROP INDEX IF EXISTS uq_task_loops_one_active_per_task;
DROP TRIGGER IF EXISTS trg_task_loops_set_updated_at ON task_loops;
DROP TABLE IF EXISTS task_loops;

DROP TRIGGER IF EXISTS trg_task_links_set_updated_at ON task_links;
ALTER TABLE task_links DROP CONSTRAINT IF EXISTS chk_task_links_type;
ALTER TABLE task_links ADD CONSTRAINT chk_task_links_type CHECK (
    link_type IN ('follow_up', 'dependency', 'retry', 'bugfix')
);
ALTER TABLE task_links
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS metadata;
