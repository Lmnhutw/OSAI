DROP INDEX IF EXISTS uq_approvals_one_pending_per_plan;
DROP INDEX IF EXISTS uq_approvals_decision_idempotency;
DROP INDEX IF EXISTS uq_approvals_plan_request_idempotency;
ALTER TABLE approvals
    DROP CONSTRAINT IF EXISTS chk_approvals_decision_version,
    DROP CONSTRAINT IF EXISTS chk_approvals_status,
    DROP COLUMN IF EXISTS decision_version,
    DROP COLUMN IF EXISTS decision_idempotency_key,
    DROP COLUMN IF EXISTS idempotency_key,
    DROP COLUMN IF EXISTS expected_plan_updated_at;
