package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct {
	pool *pgxpool.Pool
}

func NewPostgresStore(ctx context.Context, dsn string) (*PostgresStore, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("create pgx pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return &PostgresStore{pool: pool}, nil
}

func (s *PostgresStore) Close() {
	if s.pool != nil {
		s.pool.Close()
	}
}

func (s *PostgresStore) ClaimReadyTask(ctx context.Context, jiraIssueKey, workerName string) (*ClaimedTask, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin claim transaction: %w", err)
	}
	defer rollback(ctx, tx)

	row := tx.QueryRow(ctx, `
WITH candidate AS (
    SELECT t.id, t.plan_id, t.position, t.task_type, t.title, t.instructions, t.status, t.input_payload, t.created_at, t.updated_at
    FROM tasks t
    WHERE t.status = 'approved'
      AND COALESCE(
            t.input_payload->>'jira_issue_key',
            t.input_payload#>>'{jira,issue_key}',
            t.input_payload#>>'{jira,issueKey}',
            t.input_payload#>>'{jira,key}'
      ) = $1
      AND NOT EXISTS (
            SELECT 1
            FROM task_dependencies td
            JOIN tasks dep ON dep.id = td.depends_on_task_id
            WHERE td.task_id = t.id
              AND dep.status <> 'completed'
      )
    ORDER BY t.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
UPDATE tasks t
SET status = 'in_progress',
    updated_at = NOW()
FROM candidate c
WHERE t.id = c.id
RETURNING t.id::text, t.plan_id::text, t.position, t.task_type, t.title, t.instructions, t.status, t.input_payload, t.created_at, t.updated_at
`, jiraIssueKey)

	task, err := scanTask(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("claim task: %w", err)
	}

	retryCount := extractRetryCount(task.InputPayload)

	var executionIndex int
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*) + 1
FROM task_sessions
WHERE task_id = $1::uuid
`, task.ID).Scan(&executionIndex); err != nil {
		return nil, fmt.Errorf("load execution index: %w", err)
	}

	failurePatternHint := ""
	err = tx.QueryRow(ctx, `
SELECT COALESCE(
           NULLIF(er.output_payload#>>'{execution_result,metadata,failure_pattern_hint}', ''),
           NULLIF(er.output_payload#>>'{execution_result,retry,failure_fingerprint}', ''),
           NULLIF(er.output_payload->>'failure_pattern_hint', ''),
           NULLIF(er.failure_type, '')
       )
FROM execution_runs er
JOIN task_sessions ts ON ts.id = er.task_session_id
WHERE ts.task_id = $1::uuid
ORDER BY COALESCE(er.finished_at, er.created_at) DESC
LIMIT 1
`, task.ID).Scan(&failurePatternHint)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("load previous failure pattern hint: %w", err)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		failurePatternHint = ""
	}

	metadata := map[string]any{
		"jira_issue_key":       jiraIssueKey,
		"worker_name":          workerName,
		"claimed_at":           time.Now().UTC().Format(time.RFC3339),
		"execution_index":      executionIndex,
		"retry_count":          retryCount,
		"failure_pattern_hint": failurePatternHint,
	}

	var sessionID string
	err = tx.QueryRow(ctx, `
INSERT INTO task_sessions (task_id, status, metadata, started_at, created_at, updated_at)
VALUES ($1::uuid, 'running', $2::jsonb, NOW(), NOW(), NOW())
RETURNING id::text
`, task.ID, marshalJSON(metadata)).Scan(&sessionID)
	if err != nil {
		return nil, fmt.Errorf("insert task session: %w", err)
	}

	var runID string
	err = tx.QueryRow(ctx, `
INSERT INTO execution_runs (task_session_id, attempt_no, status, worker_name, input_payload, retry_count, started_at, created_at, updated_at)
VALUES ($1::uuid, 1, 'running', $2, $3::jsonb, $4, NOW(), NOW(), NOW())
RETURNING id::text
`, sessionID, workerName, marshalJSON(task.InputPayload), retryCount).Scan(&runID)
	if err != nil {
		return nil, fmt.Errorf("insert execution run: %w", err)
	}

	_, err = tx.Exec(ctx, `
INSERT INTO events (plan_id, task_id, task_session_id, execution_run_id, event_source, event_type, payload, occurred_at, created_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'execution-go', 'task_claimed', $5::jsonb, NOW(), NOW())
`, task.PlanID, task.ID, sessionID, runID, marshalJSON(metadata))
	if err != nil {
		return nil, fmt.Errorf("insert claim event: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit claim transaction: %w", err)
	}

	return &ClaimedTask{
		Task:               task,
		SessionID:          sessionID,
		RunID:              runID,
		AttemptNo:          1,
		RetryCount:         retryCount,
		ExecutionIndex:     executionIndex,
		JiraIssueKey:       jiraIssueKey,
		WorkerName:         workerName,
		FailurePatternHint: failurePatternHint,
	}, nil
}

func (s *PostgresStore) StartRetryRun(ctx context.Context, planID, taskID, sessionID, workerName string, retryCount int, inputPayload map[string]any) (*RunAttempt, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin retry transaction: %w", err)
	}
	defer rollback(ctx, tx)

	var runID string
	var attemptNo int
	var persistedRetryCount int
	err = tx.QueryRow(ctx, `
WITH next_attempt AS (
    SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no
    FROM execution_runs
    WHERE task_session_id = $1::uuid
)
INSERT INTO execution_runs (task_session_id, attempt_no, status, worker_name, input_payload, retry_count, started_at, created_at, updated_at)
SELECT $1::uuid, next_attempt.attempt_no, 'running', $2, $3::jsonb, $4, NOW(), NOW(), NOW()
FROM next_attempt
RETURNING id::text, attempt_no, retry_count
`, sessionID, workerName, marshalJSON(inputPayload), retryCount).Scan(&runID, &attemptNo, &persistedRetryCount)
	if err != nil {
		return nil, fmt.Errorf("insert retry run: %w", err)
	}

	eventPayload := map[string]any{
		"task_id":     taskID,
		"session_id":  sessionID,
		"attempt_no":  attemptNo,
		"retry_count": persistedRetryCount,
		"worker":      workerName,
	}

	_, err = tx.Exec(ctx, `
INSERT INTO events (plan_id, task_id, task_session_id, execution_run_id, event_source, event_type, payload, occurred_at, created_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'execution-go', 'retry_started', $5::jsonb, NOW(), NOW())
`, planID, taskID, sessionID, runID, marshalJSON(eventPayload))
	if err != nil {
		return nil, fmt.Errorf("insert retry event: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit retry transaction: %w", err)
	}

	return &RunAttempt{RunID: runID, AttemptNo: attemptNo, RetryCount: persistedRetryCount}, nil
}

func (s *PostgresStore) FinalizeRun(ctx context.Context, input FinalizeRunInput) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin finalize transaction: %w", err)
	}
	defer rollback(ctx, tx)

	_, err = tx.Exec(ctx, `
UPDATE execution_runs
SET status = $2,
    artifact_path = NULLIF($3, ''),
    output_payload = $4::jsonb,
    error_message = NULLIF($5, ''),
    failure_type = NULLIF($6, ''),
    retry_count = $7,
    confidence_score = $8,
    finished_at = NOW(),
    updated_at = NOW()
WHERE id = $1::uuid
`, input.RunID, input.RunStatus, input.ArtifactPath, marshalJSON(input.OutputPayload), input.ErrorMessage, input.FailureType, input.RetryCount, input.ConfidenceScore)
	if err != nil {
		return fmt.Errorf("update execution run: %w", err)
	}

	if strings.TrimSpace(input.SessionStatus) != "" {
		_, err = tx.Exec(ctx, `
UPDATE task_sessions
SET status = $2,
    artifact_path = NULLIF($3, ''),
    metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
    ended_at = NOW(),
    updated_at = NOW()
WHERE id = $1::uuid
`, input.SessionID, input.SessionStatus, input.ArtifactPath, marshalJSON(input.SessionMetadata))
		if err != nil {
			return fmt.Errorf("update task session: %w", err)
		}
	}

	if strings.TrimSpace(input.TaskStatus) != "" {
		_, err = tx.Exec(ctx, `
UPDATE tasks
SET status = $2,
    updated_at = NOW()
WHERE id = $1::uuid
`, input.TaskID, input.TaskStatus)
		if err != nil {
			return fmt.Errorf("update task: %w", err)
		}
	}

	_, err = tx.Exec(ctx, `
INSERT INTO events (plan_id, task_id, task_session_id, execution_run_id, event_source, event_type, artifact_path, payload, occurred_at, created_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'execution-go', $5, NULLIF($6, ''), $7::jsonb, NOW(), NOW())
`, input.PlanID, input.TaskID, input.SessionID, input.RunID, input.EventType, input.ArtifactPath, marshalJSON(input.EventPayload))
	if err != nil {
		return fmt.Errorf("insert finalize event: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit finalize transaction: %w", err)
	}

	return nil
}

func scanTask(row pgx.Row) (Task, error) {
	var task Task
	var inputPayloadRaw []byte
	err := row.Scan(
		&task.ID,
		&task.PlanID,
		&task.Position,
		&task.TaskType,
		&task.Title,
		&task.Instructions,
		&task.Status,
		&inputPayloadRaw,
		&task.CreatedAt,
		&task.UpdatedAt,
	)
	if err != nil {
		return Task{}, err
	}

	task.InputPayload = map[string]any{}
	if len(inputPayloadRaw) > 0 {
		if err := json.Unmarshal(inputPayloadRaw, &task.InputPayload); err != nil {
			return Task{}, fmt.Errorf("decode task input payload: %w", err)
		}
	}

	return task, nil
}

func marshalJSON(value any) string {
	if value == nil {
		return "{}"
	}
	payload, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(payload)
}

func rollback(ctx context.Context, tx pgx.Tx) {
	_ = tx.Rollback(ctx)
}

func extractRetryCount(payload map[string]any) int {
	if payload == nil {
		return 0
	}

	for _, key := range []string{"retry_count", "retryCount"} {
		value, ok := payload[key]
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case int:
			if typed > 0 {
				return typed
			}
		case int32:
			if typed > 0 {
				return int(typed)
			}
		case int64:
			if typed > 0 {
				return int(typed)
			}
		case float64:
			if typed > 0 {
				return int(typed)
			}
		case json.Number:
			if parsed, err := typed.Int64(); err == nil && parsed > 0 {
				return int(parsed)
			}
		case string:
			if parsed, err := strconv.Atoi(strings.TrimSpace(typed)); err == nil && parsed > 0 {
				return parsed
			}
		}
	}

	return 0
}
