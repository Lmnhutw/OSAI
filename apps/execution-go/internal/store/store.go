package store

import (
	"context"
	"time"
)

type Task struct {
	ID           string
	PlanID       string
	Position     int
	TaskType     string
	Title        string
	Instructions string
	Status       string
	InputPayload map[string]any
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

type ClaimedTask struct {
	Task         Task
	SessionID    string
	RunID        string
	AttemptNo    int
	JiraIssueKey string
	WorkerName   string
}

type RunAttempt struct {
	RunID     string
	AttemptNo int
}

type FinalizeRunInput struct {
	PlanID        string
	TaskID        string
	SessionID     string
	RunID         string
	RunStatus     string
	SessionStatus string
	TaskStatus    string
	ArtifactPath  string
	OutputPayload map[string]any
	SessionMetadata map[string]any
	ErrorMessage  string
	EventType     string
	EventPayload  map[string]any
}

type TaskStore interface {
	ClaimReadyTask(ctx context.Context, jiraIssueKey, workerName string) (*ClaimedTask, error)
	StartRetryRun(ctx context.Context, planID, taskID, sessionID, workerName string, inputPayload map[string]any) (*RunAttempt, error)
	FinalizeRun(ctx context.Context, input FinalizeRunInput) error
}
