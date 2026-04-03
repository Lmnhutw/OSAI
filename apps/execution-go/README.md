# execution-go

`execution-go` is the execution worker for the monorepo orchestration system. It polls Jira for issues labeled `ready-for-codex`, claims matching tasks from PostgreSQL, prepares an isolated git workspace, runs Codex plus validation commands, writes a markdown artifact into `artifacts/`, persists execution state into `task_sessions` and `execution_runs`, and syncs Jira transitions.

## Structure

```text
apps/execution-go/
  cmd/execution-worker/      service entrypoint
  internal/artifact/         markdown artifact writer
  internal/cli/              command execution helpers
  internal/config/           environment-driven configuration
  internal/jira/             Jira REST client
  internal/prompt/           Codex prompt builder
  internal/runner/           Codex and lint/test runners
  internal/store/            PostgreSQL task claim + persistence layer
  internal/worker/           orchestration loop and execution flow
  internal/workspace/        workspace creation and git checkout logic
```

## Required environment

- `EXECUTION_DB_DSN`
- `EXECUTION_JIRA_BASE_URL`
- `EXECUTION_JIRA_EMAIL` and `EXECUTION_JIRA_API_TOKEN`, or `EXECUTION_JIRA_BEARER_TOKEN`

## Useful optional environment

- `EXECUTION_WORKER_NAME`
- `EXECUTION_POLL_INTERVAL`
- `EXECUTION_MAX_CONCURRENT`
- `EXECUTION_MAX_ATTEMPTS`
- `EXECUTION_ARTIFACT_ROOT`
- `EXECUTION_WORKSPACE_ROOT`
- `EXECUTION_REPO_SOURCE`
- `EXECUTION_BASE_BRANCH`
- `EXECUTION_LINT_COMMANDS`
- `EXECUTION_TEST_COMMANDS`
- `EXECUTION_CODEX_COMMAND`
- `EXECUTION_CODEX_ARGS`
- `EXECUTION_CODEX_PROMPT_MODE`
- `EXECUTION_JIRA_IN_PROGRESS_STATUS`
- `EXECUTION_JIRA_DONE_STATUS`
- `EXECUTION_JIRA_FAILED_STATUS`

`EXECUTION_LINT_COMMANDS`, `EXECUTION_TEST_COMMANDS`, and `EXECUTION_CODEX_ARGS` accept either JSON arrays or a `;;`-delimited string.

## Runtime assumptions

- A Jira issue maps to an existing `tasks` row through `tasks.input_payload`.
- The worker looks for the issue key in `jira_issue_key`, `jira.issue_key`, `jira.issueKey`, or `jira.key`.
- Default repository source is the current monorepo root, so the worker can clone a local checkout unless a task payload or env var overrides it.
- Lint/test commands should be provided per task payload or through environment defaults. The worker fails explicitly if neither lint nor test commands are configured.
