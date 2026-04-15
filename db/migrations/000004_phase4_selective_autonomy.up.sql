-- Extend Phase 3 schema with selective autonomy decisions, policy overrides,
-- task classifications, execution contracts, and richer autonomy auditability.
-- Keep this file aligned with db/schema/schema.sql.

CREATE TABLE task_classifications (
    task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    task_class text NOT NULL,
    risk_level text NOT NULL,
    sensitivity_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
    confidence_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_task_classifications_sensitivity_flags_is_array CHECK (
        jsonb_typeof(sensitivity_flags) = 'array'
    ),
    CONSTRAINT chk_task_classifications_confidence_inputs_is_object CHECK (
        jsonb_typeof(confidence_inputs) = 'object'
    )
);

COMMENT ON TABLE task_classifications IS
    'Current classification snapshot for a task, including risk and sensitivity inputs used by policy evaluation.';
COMMENT ON COLUMN task_classifications.task_id IS
    'Task being classified. One row per task keeps the latest classification easy to fetch.';
COMMENT ON COLUMN task_classifications.task_class IS
    'Application-managed class such as implementation, infra_change, secret_access, or destructive_operation.';
COMMENT ON COLUMN task_classifications.risk_level IS
    'Application-managed risk bucket such as low, medium, high, or critical.';
COMMENT ON COLUMN task_classifications.sensitivity_flags IS
    'JSON array of sensitivity flags such as production_data, credentials, billing, or deploy_access.';
COMMENT ON COLUMN task_classifications.confidence_inputs IS
    'Structured classifier evidence, feature values, or policy inputs used to derive risk and autonomy confidence.';

CREATE INDEX idx_task_classifications_risk_level_updated_at
    ON task_classifications (risk_level, updated_at DESC);

CREATE INDEX idx_task_classifications_sensitivity_flags
    ON task_classifications
    USING GIN (sensitivity_flags);

CREATE TRIGGER trg_task_classifications_set_updated_at
BEFORE UPDATE ON task_classifications
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE autonomy_decisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    related_run_id uuid REFERENCES execution_runs(id) ON DELETE SET NULL,
    autonomy_mode text NOT NULL,
    approval_required boolean NOT NULL DEFAULT false,
    review_required boolean NOT NULL DEFAULT false,
    confidence_score numeric(5,4) NOT NULL,
    escalation_reason text,
    allowed_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
    sensitive_scope_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
    decision_summary text NOT NULL,
    evidence_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_autonomy_decisions_confidence_score CHECK (
        confidence_score >= 0 AND confidence_score <= 1
    ),
    CONSTRAINT chk_autonomy_decisions_allowed_actions_is_array CHECK (
        jsonb_typeof(allowed_actions) = 'array'
    ),
    CONSTRAINT chk_autonomy_decisions_sensitive_scope_flags_is_array CHECK (
        jsonb_typeof(sensitive_scope_flags) = 'array'
    ),
    CONSTRAINT chk_autonomy_decisions_evidence_payload_is_object CHECK (
        jsonb_typeof(evidence_payload) = 'object'
    ),
    CONSTRAINT chk_autonomy_decisions_escalation_reason CHECK (
        (NOT approval_required AND NOT review_required)
        OR NULLIF(btrim(escalation_reason), '') IS NOT NULL
    )
);

COMMENT ON TABLE autonomy_decisions IS
    'Append-only autonomy decisions recorded before task execution or run escalation. project_id is stored directly for policy dashboards and audit queries.';
COMMENT ON COLUMN autonomy_decisions.project_id IS
    'Direct project scope for autonomy dashboards without rejoining the full plan tree.';
COMMENT ON COLUMN autonomy_decisions.task_id IS
    'Task the autonomy decision applies to. Services should keep this aligned with related_run_id when run-scoped.';
COMMENT ON COLUMN autonomy_decisions.related_run_id IS
    'Optional execution run when the decision is attached to a specific attempt instead of only task scope.';
COMMENT ON COLUMN autonomy_decisions.autonomy_mode IS
    'Application-managed mode such as blocked, supervised, restricted, or autonomous.';
COMMENT ON COLUMN autonomy_decisions.allowed_actions IS
    'JSON array of action codes allowed by the decision, for example read_repo, run_tests, write_workspace, or open_pr.';
COMMENT ON COLUMN autonomy_decisions.sensitive_scope_flags IS
    'JSON array of sensitive-scope flags that influenced the decision, for example prod_env, secrets, or external_side_effect.';
COMMENT ON COLUMN autonomy_decisions.decision_summary IS
    'Human-readable explanation of why the task may or may not proceed autonomously.';
COMMENT ON COLUMN autonomy_decisions.evidence_payload IS
    'Structured evidence for explainability such as classifier outputs, policy matches, evaluation excerpts, or citations.';

CREATE INDEX idx_autonomy_decisions_project_created_at
    ON autonomy_decisions (project_id, created_at DESC);

CREATE INDEX idx_autonomy_decisions_task_created_at
    ON autonomy_decisions (task_id, created_at DESC);

CREATE INDEX idx_autonomy_decisions_project_confidence_created_at
    ON autonomy_decisions (project_id, confidence_score, created_at DESC);

CREATE INDEX idx_autonomy_decisions_related_run_id
    ON autonomy_decisions (related_run_id)
    WHERE related_run_id IS NOT NULL;

CREATE INDEX idx_autonomy_decisions_sensitive_scope_flags
    ON autonomy_decisions
    USING GIN (sensitive_scope_flags);

CREATE TABLE policy_overrides (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
    override_type text NOT NULL,
    override_value jsonb NOT NULL DEFAULT '{}'::jsonb,
    reason text NOT NULL,
    created_by text NOT NULL,
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_policy_overrides_override_value_is_object CHECK (
        jsonb_typeof(override_value) = 'object'
    ),
    CONSTRAINT chk_policy_overrides_expires_at CHECK (
        expires_at IS NULL OR expires_at >= created_at
    )
);

COMMENT ON TABLE policy_overrides IS
    'Append-only manual or system-issued overrides that change autonomy behavior at project or task scope.';
COMMENT ON COLUMN policy_overrides.project_id IS
    'Direct project scope so global overrides do not need task joins.';
COMMENT ON COLUMN policy_overrides.task_id IS
    'Optional task scope. NULL means the override applies at project scope.';
COMMENT ON COLUMN policy_overrides.override_type IS
    'Application-managed override category such as autonomy_mode, approval_bypass, retry_limit, or write_permission.';
COMMENT ON COLUMN policy_overrides.override_value IS
    'Structured override payload. Services can store named fields instead of packing opaque strings.';
COMMENT ON COLUMN policy_overrides.created_by IS
    'Actor or subsystem that issued the override, for example reviewer:alice or policy_engine.';

CREATE INDEX idx_policy_overrides_project_created_at
    ON policy_overrides (project_id, created_at DESC);

CREATE INDEX idx_policy_overrides_task_created_at
    ON policy_overrides (task_id, created_at DESC)
    WHERE task_id IS NOT NULL;

CREATE TABLE execution_contracts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    autonomy_decision_id uuid NOT NULL REFERENCES autonomy_decisions(id) ON DELETE CASCADE,
    execution_mode text NOT NULL,
    allowed_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
    retry_limit integer NOT NULL DEFAULT 0,
    branch_policy text NOT NULL,
    write_permission text NOT NULL,
    approval_state text NOT NULL DEFAULT 'not_required',
    expires_at timestamptz,
    issued_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_execution_contracts_allowed_actions_is_array CHECK (
        jsonb_typeof(allowed_actions) = 'array'
    ),
    CONSTRAINT chk_execution_contracts_retry_limit CHECK (retry_limit >= 0),
    CONSTRAINT chk_execution_contracts_expires_at CHECK (
        expires_at IS NULL OR expires_at >= issued_at
    )
);

COMMENT ON TABLE execution_contracts IS
    'Worker-facing contract derived from an autonomy decision. Contracts are append-only so workers and auditors can see exactly what rules were in force.';
COMMENT ON COLUMN execution_contracts.task_id IS
    'Task the worker is allowed to act on under this contract.';
COMMENT ON COLUMN execution_contracts.autonomy_decision_id IS
    'Source autonomy decision that justified issuing this contract. Services should keep task_id aligned with the referenced decision.';
COMMENT ON COLUMN execution_contracts.execution_mode IS
    'Application-managed mode for the worker, for example dry_run, restricted_execute, or fully_autonomous.';
COMMENT ON COLUMN execution_contracts.allowed_actions IS
    'JSON array copied or narrowed from autonomy_decisions.allowed_actions for worker enforcement.';
COMMENT ON COLUMN execution_contracts.branch_policy IS
    'Branch or isolation rule such as reuse_current_branch, require_sandbox_branch, or no_git_writes.';
COMMENT ON COLUMN execution_contracts.write_permission IS
    'Write scope granted to the worker, for example none, workspace_only, or workspace_and_git.';
COMMENT ON COLUMN execution_contracts.approval_state IS
    'Approval state observed when the contract was issued, such as pending, approved, rejected, or not_required.';

CREATE INDEX idx_execution_contracts_task_issued_at
    ON execution_contracts (task_id, issued_at DESC);

CREATE INDEX idx_execution_contracts_task_approval_state_issued_at
    ON execution_contracts (task_id, approval_state, issued_at DESC);

CREATE INDEX idx_execution_contracts_autonomy_decision_id
    ON execution_contracts (autonomy_decision_id, issued_at DESC);

ALTER TABLE task_history
    ADD COLUMN history_type text NOT NULL DEFAULT 'state_transition',
    ADD COLUMN autonomy_decision_id uuid REFERENCES autonomy_decisions(id) ON DELETE SET NULL,
    ADD COLUMN policy_override_id uuid REFERENCES policy_overrides(id) ON DELETE SET NULL,
    ADD COLUMN execution_contract_id uuid REFERENCES execution_contracts(id) ON DELETE SET NULL,
    ADD COLUMN actor text,
    ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD CONSTRAINT chk_task_history_details_is_object CHECK (
        jsonb_typeof(details) = 'object'
    );

COMMENT ON TABLE task_history IS
    'Append-only task loop and autonomy history capturing state transitions, policy decisions, overrides, and issued execution contracts over time.';
COMMENT ON COLUMN task_history.decision IS
    'Optional short rationale that explains the transition or autonomy-related event.';
COMMENT ON COLUMN task_history.history_type IS
    'Application-managed history kind such as state_transition, autonomy_decision, policy_override, or execution_contract.';
COMMENT ON COLUMN task_history.autonomy_decision_id IS
    'Optional linked autonomy decision for audit traces.';
COMMENT ON COLUMN task_history.policy_override_id IS
    'Optional linked policy override for audit traces.';
COMMENT ON COLUMN task_history.execution_contract_id IS
    'Optional linked execution contract for audit traces.';
COMMENT ON COLUMN task_history.actor IS
    'Human or subsystem that recorded the history event.';
COMMENT ON COLUMN task_history.details IS
    'Structured event details such as policy snapshots, approval metadata, or override diffs.';

CREATE INDEX idx_task_history_task_history_type_timestamp
    ON task_history (task_id, history_type, "timestamp" DESC);

CREATE INDEX idx_task_history_autonomy_decision_id
    ON task_history (autonomy_decision_id)
    WHERE autonomy_decision_id IS NOT NULL;

CREATE INDEX idx_task_history_policy_override_id
    ON task_history (policy_override_id)
    WHERE policy_override_id IS NOT NULL;

CREATE INDEX idx_task_history_execution_contract_id
    ON task_history (execution_contract_id)
    WHERE execution_contract_id IS NOT NULL;
