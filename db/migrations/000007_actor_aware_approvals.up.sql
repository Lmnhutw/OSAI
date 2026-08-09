-- Approval requests are durable commands. An actor requests, another actor
-- decides, and duplicate client retries return the original decision.

ALTER TABLE approvals
    ADD COLUMN expected_plan_updated_at timestamptz,
    ADD COLUMN idempotency_key text,
    ADD COLUMN decision_idempotency_key text,
    ADD COLUMN decision_version integer NOT NULL DEFAULT 1;

ALTER TABLE approvals
    ADD CONSTRAINT chk_approvals_status CHECK (status IN ('pending', 'approved', 'rejected', 'changes_requested')),
    ADD CONSTRAINT chk_approvals_decision_version CHECK (decision_version >= 1);

CREATE UNIQUE INDEX uq_approvals_plan_request_idempotency
    ON approvals (plan_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_approvals_decision_idempotency
    ON approvals (decision_idempotency_key)
    WHERE decision_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_approvals_one_pending_per_plan
    ON approvals (plan_id)
    WHERE status = 'pending';
