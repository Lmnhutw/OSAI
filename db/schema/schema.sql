-- Phase 4 PostgreSQL schema for the orchestration system.
-- This file is a full schema snapshot and is intentionally language-agnostic:
-- no ORM assumptions, UUID primary keys, plain SQL constraints, and JSONB only
-- where flexible payloads are useful to both Python and Go services.
--
-- Relationship summary:
--   projects -> project_requirements
--   projects -> memory_items
--   projects -> failure_patterns
--   projects -> autonomy_decisions -> execution_contracts
--   projects -> plans -> tasks -> task_sessions -> execution_runs
--   projects -> plans -> tasks -> task_classifications
--   projects -> plans -> tasks -> task_history
--   projects/tasks -> policy_overrides
--   task_sessions -> task_session_memory_links -> memory_items
--   tasks/task_sessions/execution_runs -> evaluation_results
--   tasks -> task_dependencies (self-referential dependency graph)
--   tasks -> task_links (self-referential chaining graph)
--   plans -> approvals
--   task_history can point at autonomy_decisions, policy_overrides, and execution_contracts
--   events can point at project, plan, task, task_session, and/or execution_run
--
-- Notes:
--   * gen_random_uuid() requires pgcrypto, enabled below.
--   * status columns are TEXT on purpose to keep rollouts simple in Phase 1.
--   * artifact_path is stored on task_sessions, execution_runs, and events for logs.
--   * memory_items adds a lightweight full-text retrieval path for curated knowledge.
--   * task_links generalizes chaining without removing legacy task_dependencies.
--   * autonomy_decisions stores direct project/task scope for explainable policy decisions.
--   * execution_contracts captures the exact worker permissions issued from an autonomy decision.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- Root entity. A project owns requirements and plans.
CREATE TABLE projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    description text,
    status text NOT NULL DEFAULT 'draft',
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE projects IS
    'Root entity for orchestration. A project owns many requirements and plans.';
COMMENT ON COLUMN projects.status IS
    'Application-managed lifecycle state such as draft, planning, approved, running, completed, or failed.';

CREATE INDEX idx_projects_status_created_at
    ON projects (status, created_at DESC);

CREATE TRIGGER trg_projects_set_updated_at
BEFORE UPDATE ON projects
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Ordered requirements captured for a project. Each row belongs to one project.
CREATE TABLE project_requirements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    position integer NOT NULL,
    requirement_text text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_project_requirements_position CHECK (position >= 1)
);

COMMENT ON TABLE project_requirements IS
    'Requirement rows for a project. The ordered list is scoped by project_id.';
COMMENT ON COLUMN project_requirements.project_id IS
    'Parent project for this requirement row.';

CREATE UNIQUE INDEX uq_project_requirements_project_position
    ON project_requirements (project_id, position);

CREATE INDEX idx_project_requirements_project_created_at
    ON project_requirements (project_id, created_at DESC);

CREATE TRIGGER trg_project_requirements_set_updated_at
BEFORE UPDATE ON project_requirements
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- A plan is a versioned orchestration proposal for a project.
CREATE TABLE plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version integer NOT NULL,
    title text NOT NULL,
    summary text,
    status text NOT NULL DEFAULT 'draft',
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_plans_version CHECK (version >= 1)
);

COMMENT ON TABLE plans IS
    'Versioned execution plan for a project. A plan owns tasks and approval records.';
COMMENT ON COLUMN plans.project_id IS
    'Parent project that this plan belongs to.';

CREATE UNIQUE INDEX uq_plans_project_version
    ON plans (project_id, version);

CREATE INDEX idx_plans_project_status_created_at
    ON plans (project_id, status, created_at DESC);

CREATE TRIGGER trg_plans_set_updated_at
BEFORE UPDATE ON plans
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Tasks are the executable units within a plan.
CREATE TABLE tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    position integer NOT NULL,
    task_type text NOT NULL DEFAULT 'generic',
    title text NOT NULL,
    instructions text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    input_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_tasks_position CHECK (position >= 1)
);

COMMENT ON TABLE tasks IS
    'Executable units within a plan. Each task may have dependencies and execution sessions.';
COMMENT ON COLUMN tasks.plan_id IS
    'Parent plan that owns this task.';

CREATE UNIQUE INDEX uq_tasks_plan_position
    ON tasks (plan_id, position);

CREATE INDEX idx_tasks_plan_status_position
    ON tasks (plan_id, status, position);

CREATE TRIGGER trg_tasks_set_updated_at
BEFORE UPDATE ON tasks
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Latest task classification snapshot used by policy and confidence evaluation.
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

-- Dependency graph for tasks. A task cannot start until its dependency is satisfied.
CREATE TABLE task_dependencies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    dependency_type text NOT NULL DEFAULT 'blocks',
    created_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_task_dependencies_not_self CHECK (task_id <> depends_on_task_id)
);

COMMENT ON TABLE task_dependencies IS
    'Self-referential join table for task ordering. Phase 1 expects both tasks to belong to the same plan; services should enforce that.';
COMMENT ON COLUMN task_dependencies.task_id IS
    'Task that is blocked.';
COMMENT ON COLUMN task_dependencies.depends_on_task_id IS
    'Task that must complete before task_id can proceed.';

CREATE UNIQUE INDEX uq_task_dependencies_task_depends_on
    ON task_dependencies (task_id, depends_on_task_id);

CREATE INDEX idx_task_dependencies_depends_on_task_id
    ON task_dependencies (depends_on_task_id);

-- Generalized task chaining graph for loops, retries, and follow-up work.
-- task_dependencies remains intact for backward compatibility with earlier phases.
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

-- Loop history is append-only so control-plane decisions remain auditable.
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

-- Phase 1 approvals are scoped to plans.
CREATE TABLE approvals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    requested_by text NOT NULL,
    approver text,
    status text NOT NULL DEFAULT 'pending',
    decision_note text,
    requested_at timestamptz NOT NULL DEFAULT NOW(),
    decided_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_approvals_decided_at CHECK (
        decided_at IS NULL OR decided_at >= requested_at
    )
);

COMMENT ON TABLE approvals IS
    'Approval records for a plan. Multiple rows allow re-review or resubmission over time.';
COMMENT ON COLUMN approvals.plan_id IS
    'Approved or rejected plan.';

CREATE INDEX idx_approvals_plan_status_requested_at
    ON approvals (plan_id, status, requested_at DESC);

CREATE INDEX idx_approvals_status_requested_at
    ON approvals (status, requested_at DESC);

CREATE TRIGGER trg_approvals_set_updated_at
BEFORE UPDATE ON approvals
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Curated knowledge for a project. Phase 2 stores reusable decisions, constraints,
-- bug patterns, and lessons as first-class rows instead of burying them in run logs.
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

-- A task session groups one logical execution thread for a task.
CREATE TABLE task_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'open',
    artifact_path text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_at timestamptz NOT NULL DEFAULT NOW(),
    ended_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_task_sessions_ended_at CHECK (
        ended_at IS NULL OR ended_at >= started_at
    )
);

COMMENT ON TABLE task_sessions IS
    'Logical execution session for a task. A session owns one or more execution runs and can store session-level log artifacts.';
COMMENT ON COLUMN task_sessions.task_id IS
    'Task being executed across one or more attempts.';
COMMENT ON COLUMN task_sessions.artifact_path IS
    'Optional path to session-level logs, transcripts, or combined artifacts.';

CREATE INDEX idx_task_sessions_task_status_started_at
    ON task_sessions (task_id, status, started_at DESC);

CREATE INDEX idx_task_sessions_started_at
    ON task_sessions (started_at DESC);

CREATE TRIGGER trg_task_sessions_set_updated_at
BEFORE UPDATE ON task_sessions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Link sessions to reusable memory so a future retrieval layer can trace why a
-- decision or lesson exists and which execution history produced or validated it.
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

-- One execution attempt inside a task session. Retries create new rows.
CREATE TABLE execution_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_session_id uuid NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
    attempt_no integer NOT NULL,
    status text NOT NULL DEFAULT 'queued',
    worker_name text,
    artifact_path text,
    input_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    output_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    error_message text,
    failure_type text,
    retry_count integer NOT NULL DEFAULT 0,
    last_retry_at timestamptz,
    confidence_score numeric(5,4),
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_execution_runs_attempt_no CHECK (attempt_no >= 1),
    CONSTRAINT chk_execution_runs_retry_count CHECK (retry_count >= 0),
    CONSTRAINT chk_execution_runs_confidence_score CHECK (
        confidence_score IS NULL
        OR (confidence_score >= 0 AND confidence_score <= 1)
    ),
    CONSTRAINT chk_execution_runs_finished_at CHECK (
        finished_at IS NULL
        OR started_at IS NULL
        OR finished_at >= started_at
    )
);

COMMENT ON TABLE execution_runs IS
    'Per-attempt execution records for a task session. artifact_path points to run-specific logs or outputs.';
COMMENT ON COLUMN execution_runs.task_session_id IS
    'Parent task session for this execution attempt.';
COMMENT ON COLUMN execution_runs.artifact_path IS
    'Optional path to per-run logs, stdout/stderr archives, or execution output bundles.';
COMMENT ON COLUMN execution_runs.failure_type IS
    'Optional normalized failure classification such as timeout, validation_error, or tool_error.';
COMMENT ON COLUMN execution_runs.retry_count IS
    'Zero-based retry counter. attempt_no stays unchanged for backward compatibility.';
COMMENT ON COLUMN execution_runs.last_retry_at IS
    'Timestamp when this execution attempt was most recently scheduled or launched as a retry.';
COMMENT ON COLUMN execution_runs.confidence_score IS
    'Optional confidence signal on a 0-1 scale for dispatch or execution quality.';

CREATE UNIQUE INDEX uq_execution_runs_session_attempt
    ON execution_runs (task_session_id, attempt_no);

CREATE INDEX idx_execution_runs_session_status_created_at
    ON execution_runs (task_session_id, status, created_at DESC);

CREATE INDEX idx_execution_runs_task_session_created_at
    ON execution_runs (task_session_id, created_at DESC);

-- Supports feeds and dashboards that show the most recent runs, including queued runs with no started_at yet.
CREATE INDEX idx_execution_runs_created_at
    ON execution_runs (created_at DESC);

CREATE INDEX idx_execution_runs_last_retry_at
    ON execution_runs (last_retry_at DESC)
    WHERE last_retry_at IS NOT NULL;

CREATE INDEX idx_execution_runs_started_at
    ON execution_runs (started_at DESC);

CREATE TRIGGER trg_execution_runs_set_updated_at
BEFORE UPDATE ON execution_runs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Append-only autonomy decisions recorded before task execution or run escalation.
-- project_id is stored directly so policy dashboards do not need to re-join the full plan tree.
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

-- Manual or system-issued overrides that can supersede normal policy evaluation.
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

-- Worker-facing contract derived from an autonomy decision.
-- Contracts stay append-only so auditors can see the exact permissions that were issued.
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

-- Flexible evaluation log for dispatching, result review, reviewer feedback, and QA.
-- project_id is stored directly so project dashboards do not need to re-join the full
-- execution tree every time they fetch recent evaluations.
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

-- Aggregated recurring failures at project scope. This allows loop controllers
-- to detect repeated breakage without scanning the full execution history.
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

-- Append-only event stream for project, plan, task, session, and run lifecycle changes.
CREATE TABLE events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
    plan_id uuid REFERENCES plans(id) ON DELETE CASCADE,
    task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
    task_session_id uuid REFERENCES task_sessions(id) ON DELETE CASCADE,
    execution_run_id uuid REFERENCES execution_runs(id) ON DELETE CASCADE,
    event_source text NOT NULL,
    event_type text NOT NULL,
    artifact_path text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT NOW(),
    created_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_events_has_scope CHECK (
        num_nonnulls(project_id, plan_id, task_id, task_session_id, execution_run_id) >= 1
    )
);

COMMENT ON TABLE events IS
    'Append-only event journal. An event may be attached at project, plan, task, session, or execution-run scope, with at least one scope reference required.';
COMMENT ON COLUMN events.artifact_path IS
    'Optional path to logs or serialized evidence associated with this specific event.';
COMMENT ON COLUMN events.event_source IS
    'Producer of the event, for example control_plane or execution.';

CREATE INDEX idx_events_project_occurred_at
    ON events (project_id, occurred_at DESC);

CREATE INDEX idx_events_plan_occurred_at
    ON events (plan_id, occurred_at DESC);

CREATE INDEX idx_events_task_occurred_at
    ON events (task_id, occurred_at DESC);

CREATE INDEX idx_events_task_session_occurred_at
    ON events (task_session_id, occurred_at DESC);

CREATE INDEX idx_events_execution_run_occurred_at
    ON events (execution_run_id, occurred_at DESC);

CREATE INDEX idx_events_type_occurred_at
    ON events (event_type, occurred_at DESC);
