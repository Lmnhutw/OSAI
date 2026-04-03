-- Remove Phase 2 additions in reverse dependency order.

DROP TABLE IF EXISTS evaluation_results;

DROP INDEX IF EXISTS idx_execution_runs_created_at;

ALTER TABLE IF EXISTS execution_runs
    DROP CONSTRAINT IF EXISTS chk_execution_runs_confidence_score,
    DROP CONSTRAINT IF EXISTS chk_execution_runs_retry_count,
    DROP COLUMN IF EXISTS confidence_score,
    DROP COLUMN IF EXISTS retry_count,
    DROP COLUMN IF EXISTS failure_type;

DROP TABLE IF EXISTS task_session_memory_links;
DROP TABLE IF EXISTS memory_items;
