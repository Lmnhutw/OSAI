-- Remove Phase 4 additions in reverse dependency order.

DROP INDEX IF EXISTS idx_task_history_execution_contract_id;
DROP INDEX IF EXISTS idx_task_history_policy_override_id;
DROP INDEX IF EXISTS idx_task_history_autonomy_decision_id;
DROP INDEX IF EXISTS idx_task_history_task_history_type_timestamp;

ALTER TABLE IF EXISTS task_history
    DROP CONSTRAINT IF EXISTS chk_task_history_details_is_object,
    DROP COLUMN IF EXISTS details,
    DROP COLUMN IF EXISTS actor,
    DROP COLUMN IF EXISTS execution_contract_id,
    DROP COLUMN IF EXISTS policy_override_id,
    DROP COLUMN IF EXISTS autonomy_decision_id,
    DROP COLUMN IF EXISTS history_type;

DROP TABLE IF EXISTS execution_contracts;
DROP TABLE IF EXISTS policy_overrides;
DROP TABLE IF EXISTS autonomy_decisions;
DROP TABLE IF EXISTS task_classifications;
