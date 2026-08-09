-- Durable idempotency record for Jira issue creation. A task maps to one
-- external issue; retries reuse the task label before creating anything.

CREATE TABLE jira_issue_mappings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    sync_status text NOT NULL DEFAULT 'pending',
    external_issue_key text,
    external_issue_url text,
    idempotency_key text NOT NULL UNIQUE,
    request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    error_message text,
    attempt_count integer NOT NULL DEFAULT 0,
    last_attempt_at timestamptz,
    synchronized_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_jira_issue_mappings_status CHECK (sync_status IN ('pending', 'synchronized', 'failed', 'disabled')),
    CONSTRAINT chk_jira_issue_mappings_request_payload CHECK (jsonb_typeof(request_payload) = 'object'),
    CONSTRAINT chk_jira_issue_mappings_attempt_count CHECK (attempt_count >= 0),
    CONSTRAINT chk_jira_issue_mappings_success_key CHECK (
        sync_status <> 'synchronized' OR NULLIF(btrim(external_issue_key), '') IS NOT NULL
    )
);

CREATE INDEX idx_jira_issue_mappings_project_status_updated_at
    ON jira_issue_mappings (project_id, sync_status, updated_at DESC);
CREATE INDEX idx_jira_issue_mappings_retryable
    ON jira_issue_mappings (updated_at ASC)
    WHERE sync_status IN ('pending', 'failed');
CREATE TRIGGER trg_jira_issue_mappings_set_updated_at
BEFORE UPDATE ON jira_issue_mappings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
