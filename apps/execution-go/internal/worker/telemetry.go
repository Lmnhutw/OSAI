package worker

import (
	"context"
	"log/slog"
	"time"

	"execution-go/internal/cli"
	execresult "execution-go/internal/result"
	"execution-go/internal/store"
)

func (s *Service) emitTelemetry(
	ctx context.Context,
	claimed *store.ClaimedTask,
	spec ExecutionSpec,
	entries *[]execresult.TelemetryEntry,
	stage string,
	status string,
	details map[string]any,
) {
	timestamp := time.Now().UTC()
	payload := make(map[string]any, len(details)+7)
	for key, value := range details {
		payload[key] = value
	}
	payload["task_id"] = spec.TaskID
	payload["run_id"] = spec.RunID
	payload["worker_id"] = s.cfg.WorkerName
	payload["execution_contract_id"] = spec.Contract.ID
	payload["policy_version"] = firstNonEmpty(spec.PolicySnapshot.Version, spec.Contract.PolicyVersion)
	payload["stage"] = stage
	payload["status"] = status

	entry := execresult.TelemetryEntry{
		Stage:     stage,
		Status:    status,
		Timestamp: timestamp,
		Details:   payload,
	}
	*entries = append(*entries, entry)

	s.logger.Info(
		"execution telemetry",
		slog.String("stage", stage),
		slog.String("status", status),
		slog.String("task_id", spec.TaskID),
		slog.String("run_id", spec.RunID),
		slog.String("worker_id", s.cfg.WorkerName),
		slog.String("contract_id", spec.Contract.ID),
	)

	if err := s.store.RecordEvent(ctx, store.RecordEventInput{
		PlanID:       claimed.Task.PlanID,
		TaskID:       claimed.Task.ID,
		SessionID:    claimed.SessionID,
		RunID:        spec.RunID,
		EventType:    "execution.telemetry." + stage,
		EventPayload: payload,
	}); err != nil {
		s.logger.Warn("failed to record execution telemetry", "stage", stage, "task_id", spec.TaskID, "error", err)
	}
}

func telemetryStatus(success bool) string {
	if success {
		return "succeeded"
	}
	return "failed"
}

func summarizeExecutionError(runErr error, result cli.Result) string {
	if runErr != nil {
		return runErr.Error()
	}
	if result.Success() {
		return ""
	}
	return summarizeCommandFailure(result)
}

func allCommandsSucceeded(results []cli.Result) bool {
	for _, result := range results {
		if !result.Success() {
			return false
		}
	}
	return true
}

func countFailedCommands(results []cli.Result) int {
	count := 0
	for _, result := range results {
		if !result.Success() {
			count++
		}
	}
	return count
}

func failureStatus(status execresult.Status) bool {
	return status == execresult.StatusFailed || status == execresult.StatusRetryableFailure || status == execresult.StatusValidationFailed
}
