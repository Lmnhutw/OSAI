-- Model-agnostic AI runtime. Logical profiles are deliberately limited to
-- reasoning, execution, and review for the first production release.

CREATE TABLE model_providers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_key text NOT NULL UNIQUE,
    provider_type text NOT NULL,
    display_name text NOT NULL,
    base_url text,
    secret_ref text,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_model_providers_type CHECK (provider_type IN ('openai_compatible', 'anthropic', 'gemini', 'ollama', 'huggingface', 'test')),
    CONSTRAINT chk_model_providers_secret_ref CHECK (secret_ref IS NULL OR secret_ref !~* '(api[_-]?key|token|secret)\\s*=')
);

CREATE TABLE model_configurations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile text NOT NULL UNIQUE,
    provider_id uuid NOT NULL REFERENCES model_providers(id) ON DELETE RESTRICT,
    model_name text NOT NULL,
    temperature numeric(3,2) NOT NULL DEFAULT 0.20,
    max_output_tokens integer NOT NULL DEFAULT 4096,
    timeout_seconds integer NOT NULL DEFAULT 60,
    max_retries integer NOT NULL DEFAULT 1,
    capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_model_configurations_profile CHECK (profile IN ('reasoning', 'execution', 'review')),
    CONSTRAINT chk_model_configurations_temperature CHECK (temperature >= 0 AND temperature <= 2),
    CONSTRAINT chk_model_configurations_output_tokens CHECK (max_output_tokens > 0),
    CONSTRAINT chk_model_configurations_timeout CHECK (timeout_seconds > 0),
    CONSTRAINT chk_model_configurations_retries CHECK (max_retries >= 0),
    CONSTRAINT chk_model_configurations_capabilities_is_array CHECK (jsonb_typeof(capabilities) = 'array')
);

CREATE TABLE prompt_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_key text NOT NULL,
    version integer NOT NULL,
    system_prompt text NOT NULL,
    input_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
    output_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
    prompt_checksum text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_prompt_versions_version CHECK (version >= 1),
    CONSTRAINT chk_prompt_versions_input_schema_is_object CHECK (jsonb_typeof(input_schema) = 'object'),
    CONSTRAINT chk_prompt_versions_output_schema_is_object CHECK (jsonb_typeof(output_schema) = 'object'),
    CONSTRAINT uq_prompt_versions_agent_version UNIQUE (agent_key, version),
    CONSTRAINT uq_prompt_versions_agent_checksum UNIQUE (agent_key, prompt_checksum)
);

CREATE TABLE agent_definitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_key text NOT NULL UNIQUE,
    display_name text NOT NULL,
    model_profile text NOT NULL REFERENCES model_configurations(profile) ON UPDATE CASCADE,
    active_prompt_version_id uuid REFERENCES prompt_versions(id) ON DELETE SET NULL,
    approval_policy text NOT NULL DEFAULT 'approval_required',
    tool_permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_agent_definitions_approval_policy CHECK (approval_policy IN ('manual', 'approval_required', 'constrained_auto', 'fully_auto')),
    CONSTRAINT chk_agent_definitions_tool_permissions_is_array CHECK (jsonb_typeof(tool_permissions) = 'array')
);

CREATE TABLE workflow_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    plan_id uuid REFERENCES plans(id) ON DELETE SET NULL,
    task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    workflow_type text NOT NULL,
    status text NOT NULL DEFAULT 'created',
    correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
    idempotency_key text,
    initiated_by text NOT NULL,
    input_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    output_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_workflow_runs_status CHECK (status IN ('created', 'awaiting_approval', 'running', 'blocked', 'failed', 'completed', 'cancelled')),
    CONSTRAINT chk_workflow_runs_input_payload_is_object CHECK (jsonb_typeof(input_payload) = 'object'),
    CONSTRAINT chk_workflow_runs_output_payload_is_object CHECK (jsonb_typeof(output_payload) = 'object'),
    CONSTRAINT chk_workflow_runs_finished_at CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE agent_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_run_id uuid REFERENCES workflow_runs(id) ON DELETE SET NULL,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    plan_id uuid REFERENCES plans(id) ON DELETE SET NULL,
    task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    agent_definition_id uuid REFERENCES agent_definitions(id) ON DELETE SET NULL,
    model_configuration_id uuid REFERENCES model_configurations(id) ON DELETE SET NULL,
    prompt_version_id uuid REFERENCES prompt_versions(id) ON DELETE SET NULL,
    agent_key text NOT NULL,
    model_profile text NOT NULL,
    status text NOT NULL DEFAULT 'queued',
    correlation_id uuid NOT NULL,
    input_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    output_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    error_code text,
    error_message text,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_agent_runs_profile CHECK (model_profile IN ('reasoning', 'execution', 'review')),
    CONSTRAINT chk_agent_runs_status CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked')),
    CONSTRAINT chk_agent_runs_input_payload_is_object CHECK (jsonb_typeof(input_payload) = 'object'),
    CONSTRAINT chk_agent_runs_output_payload_is_object CHECK (jsonb_typeof(output_payload) = 'object'),
    CONSTRAINT chk_agent_runs_finished_at CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE model_calls (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    model_configuration_id uuid REFERENCES model_configurations(id) ON DELETE SET NULL,
    provider_key text NOT NULL,
    provider_model_name text NOT NULL,
    provider_request_id text,
    status text NOT NULL,
    input_tokens integer,
    output_tokens integer,
    estimated_cost_usd numeric(12,6),
    latency_ms integer,
    error_code text,
    error_message text,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_model_calls_status CHECK (status IN ('succeeded', 'failed', 'timeout', 'rate_limited', 'cancelled')),
    CONSTRAINT chk_model_calls_input_tokens CHECK (input_tokens IS NULL OR input_tokens >= 0),
    CONSTRAINT chk_model_calls_output_tokens CHECK (output_tokens IS NULL OR output_tokens >= 0),
    CONSTRAINT chk_model_calls_cost CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
    CONSTRAINT chk_model_calls_latency CHECK (latency_ms IS NULL OR latency_ms >= 0)
);

CREATE UNIQUE INDEX uq_workflow_runs_project_idempotency_key ON workflow_runs (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_workflow_runs_project_status_created_at ON workflow_runs (project_id, status, created_at DESC);
CREATE INDEX idx_workflow_runs_correlation_id ON workflow_runs (correlation_id);
CREATE INDEX idx_agent_runs_task_created_at ON agent_runs (task_id, created_at DESC) WHERE task_id IS NOT NULL;
CREATE INDEX idx_agent_runs_project_status_created_at ON agent_runs (project_id, status, created_at DESC);
CREATE INDEX idx_agent_runs_correlation_id ON agent_runs (correlation_id);
CREATE INDEX idx_model_calls_agent_run_created_at ON model_calls (agent_run_id, created_at DESC);
CREATE INDEX idx_model_calls_provider_status_created_at ON model_calls (provider_key, status, created_at DESC);

CREATE TRIGGER trg_model_providers_set_updated_at BEFORE UPDATE ON model_providers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_model_configurations_set_updated_at BEFORE UPDATE ON model_configurations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_agent_definitions_set_updated_at BEFORE UPDATE ON agent_definitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_workflow_runs_set_updated_at BEFORE UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_agent_runs_set_updated_at BEFORE UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
