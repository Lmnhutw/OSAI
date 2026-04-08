-- Remove Phase 3 additions in reverse dependency order.

DROP TABLE IF EXISTS failure_patterns;
DROP TABLE IF EXISTS task_history;
DROP TABLE IF EXISTS task_links;

DROP INDEX IF EXISTS idx_execution_runs_last_retry_at;
DROP INDEX IF EXISTS idx_execution_runs_task_session_created_at;

ALTER TABLE IF EXISTS execution_runs
    DROP COLUMN IF EXISTS last_retry_at;
