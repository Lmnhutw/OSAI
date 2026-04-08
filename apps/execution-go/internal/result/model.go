package result

import (
	"strings"
	"time"
)

type Status string

const (
	StatusSucceeded        Status = "succeeded"
	StatusPartialSuccess   Status = "partial_success"
	StatusValidationFailed Status = "validation_failed"
	StatusRetryableFailure Status = "retryable_failure"
	StatusFailed           Status = "failed"
)

type FailureClassification string

const (
	FailureClassificationNone                 FailureClassification = ""
	FailureClassificationConfigurationError   FailureClassification = "configuration_error"
	FailureClassificationWorkspaceFailure     FailureClassification = "workspace_failure"
	FailureClassificationCodexExecutionFailed FailureClassification = "codex_execution_failed"
	FailureClassificationValidationFailure    FailureClassification = "validation_failure"
	FailureClassificationArtifactFailure      FailureClassification = "artifact_failure"
	FailureClassificationRepeatedPattern      FailureClassification = "repeated_failure_pattern"
	FailureClassificationUnknown              FailureClassification = "unknown_failure"
)

type ConfidenceLevel string

const (
	ConfidenceLow    ConfidenceLevel = "low"
	ConfidenceMedium ConfidenceLevel = "medium"
	ConfidenceHigh   ConfidenceLevel = "high"
)

type Confidence struct {
	Score   float64         `json:"score"`
	Level   ConfidenceLevel `json:"level"`
	Signals []string        `json:"signals,omitempty"`
}

type CommandSummary struct {
	Label     string `json:"label"`
	Kind      string `json:"kind,omitempty"`
	Command   string `json:"command,omitempty"`
	Passed    bool   `json:"passed"`
	ExitCode  int    `json:"exit_code"`
	TimedOut  bool   `json:"timed_out"`
	Duration  string `json:"duration,omitempty"`
	ErrorHint string `json:"error_hint,omitempty"`
}

type ValidationSummary struct {
	Total      int              `json:"total"`
	Passed     int              `json:"passed"`
	Failed     int              `json:"failed"`
	LintTotal  int              `json:"lint_total"`
	LintPassed int              `json:"lint_passed"`
	LintFailed int              `json:"lint_failed"`
	TestTotal  int              `json:"test_total"`
	TestPassed int              `json:"test_passed"`
	TestFailed int              `json:"test_failed"`
	Commands   []CommandSummary `json:"commands,omitempty"`
}

type RetryGuidance struct {
	Eligible               bool     `json:"eligible"`
	Remaining              int      `json:"remaining"`
	MaxAttempts            int      `json:"max_attempts"`
	RepeatedFailurePattern bool     `json:"repeated_failure_pattern"`
	FailureFingerprint     string   `json:"failure_fingerprint,omitempty"`
	Reason                 string   `json:"reason,omitempty"`
	Suggestions            []string `json:"suggestions,omitempty"`
}

type PartialExecution struct {
	EarlyExit                bool   `json:"early_exit"`
	IncompleteImplementation bool   `json:"incomplete_implementation"`
	ReasonCode               string `json:"reason_code,omitempty"`
	Reason                   string `json:"reason,omitempty"`
}

type ExecutionMetadata struct {
	RunID              string `json:"run_id,omitempty"`
	ExecutionIndex     int    `json:"execution_index"`
	RetryCount         int    `json:"retry_count"`
	FailurePatternHint string `json:"failure_pattern_hint,omitempty"`
	BranchName         string `json:"branch_name,omitempty"`
	BranchStrategy     string `json:"branch_strategy,omitempty"`
	WorkspaceCleaned   bool   `json:"workspace_cleaned"`
}

type AttemptSummary struct {
	AttemptNo              int                   `json:"attempt_no"`
	RetryCount             int                   `json:"retry_count"`
	Status                 Status                `json:"status"`
	Summary                string                `json:"summary,omitempty"`
	FailureReason          string                `json:"failure_reason,omitempty"`
	FailureType            FailureClassification `json:"failure_type,omitempty"`
	FailureClassification  FailureClassification `json:"failure_classification,omitempty"`
	DetectedAnomalies      []string              `json:"detected_anomalies,omitempty"`
	RetrySuggestions       []string              `json:"retry_suggestions,omitempty"`
	RootCauseHints         []string              `json:"root_cause_hints,omitempty"`
	FailurePatternHint     string                `json:"failure_pattern_hint,omitempty"`
	RepeatedFailurePattern bool                  `json:"repeated_failure_pattern,omitempty"`
	Validation             ValidationSummary     `json:"validation"`
	Confidence             Confidence            `json:"confidence"`
}

type EvaluationHandoff struct {
	Ready               bool   `json:"ready"`
	State               string `json:"state,omitempty"`
	EventType           string `json:"event_type,omitempty"`
	FinalOutcomeDecided bool   `json:"final_outcome_decided"`
}

type ExecutionResult struct {
	Status                Status                `json:"status"`
	Summary               string                `json:"summary"`
	ReasoningSummary      string                `json:"reasoning_summary,omitempty"`
	FailureReason         string                `json:"failure_reason,omitempty"`
	FailureClassification FailureClassification `json:"failure_classification,omitempty"`
	FailureType           FailureClassification `json:"failure_type,omitempty"`
	RetrySuggestions      []string              `json:"retry_suggestions,omitempty"`
	RootCauseHints        []string              `json:"root_cause_hints,omitempty"`
	Partial               PartialExecution      `json:"partial"`
	Confidence            Confidence            `json:"confidence"`
	DetectedAnomalies     []string              `json:"detected_anomalies,omitempty"`
	Retry                 RetryGuidance         `json:"retry"`
	Validation            ValidationSummary     `json:"validation"`
	FilesChanged          []string              `json:"files_changed,omitempty"`
	PromptFile            string                `json:"prompt_file,omitempty"`
	ArtifactPath          string                `json:"artifact_path,omitempty"`
	JiraIssueKey          string                `json:"jira_issue_key,omitempty"`
	AttemptCount          int                   `json:"attempt_count"`
	Metadata              ExecutionMetadata     `json:"metadata"`
	History               []AttemptSummary      `json:"history,omitempty"`
	Evaluation            EvaluationHandoff     `json:"evaluation"`
	CompletedAt           time.Time             `json:"completed_at"`
}

func (r ExecutionResult) HasFailure() bool {
	if r.Status == StatusFailed || r.Status == StatusValidationFailed || r.Status == StatusRetryableFailure {
		return true
	}
	if r.Status == StatusPartialSuccess {
		return r.Partial.EarlyExit || r.Partial.IncompleteImplementation || strings.TrimSpace(r.FailureReason) != ""
	}
	return false
}
