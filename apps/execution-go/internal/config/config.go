package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	defaultReadyLabel      = "ready-for-codex"
	defaultBaseBranch      = "main"
	defaultCodexCommand    = "codex"
	defaultCodexPromptMode = "stdin"
)

type Config struct {
	RepoRoot             string
	DBDSN                string
	WorkerName           string
	PollInterval         time.Duration
	MaxConcurrent        int
	MaxAttempts          int
	ArtifactRoot         string
	WorkspaceRoot        string
	DefaultRepoSource    string
	DefaultBaseBranch    string
	DefaultWorkingDir    string
	DefaultLintCommands  []string
	DefaultTestCommands  []string
	CodexCommand         string
	CodexArgs            []string
	CodexPromptMode      string
	CommandTimeout       time.Duration
	CodexTimeout         time.Duration
	TaskTimeout          time.Duration
	GitTimeout           time.Duration
	JiraRequestTimeout   time.Duration
	ClaimTimeout         time.Duration
	JiraBaseURL          string
	JiraProjectKey       string
	JiraReadyLabel       string
	JiraPollPageSize     int
	JiraEmail            string
	JiraAPIToken         string
	JiraBearerToken      string
	JiraInProgressStatus string
	JiraEvaluationStatus string
	JiraDoneStatus       string
	JiraFailedStatus     string
}

type JiraClientConfig struct {
	BaseURL        string
	ProjectKey     string
	ReadyLabel     string
	Email          string
	APIToken       string
	BearerToken    string
	RequestTimeout time.Duration
}

func Load() (Config, error) {
	wd, err := os.Getwd()
	if err != nil {
		return Config{}, fmt.Errorf("get working directory: %w", err)
	}

	repoRoot := findRepoRoot(wd)
	if repoRoot == "" {
		repoRoot = wd
	}

	cfg := Config{
		RepoRoot:             repoRoot,
		DBDSN:                strings.TrimSpace(os.Getenv("EXECUTION_DB_DSN")),
		WorkerName:           envOr("EXECUTION_WORKER_NAME", hostnameOr("execution-go-worker")),
		PollInterval:         durationOr("EXECUTION_POLL_INTERVAL", 30*time.Second),
		MaxConcurrent:        intOr("EXECUTION_MAX_CONCURRENT", 1),
		MaxAttempts:          intOr("EXECUTION_MAX_ATTEMPTS", 2),
		ArtifactRoot:         envOr("EXECUTION_ARTIFACT_ROOT", filepath.Join(repoRoot, "artifacts", "execution-go")),
		WorkspaceRoot:        envOr("EXECUTION_WORKSPACE_ROOT", filepath.Join(os.TempDir(), "execution-go-workspaces")),
		DefaultRepoSource:    envOr("EXECUTION_REPO_SOURCE", repoRoot),
		DefaultBaseBranch:    envOr("EXECUTION_BASE_BRANCH", defaultBaseBranch),
		DefaultWorkingDir:    strings.TrimSpace(os.Getenv("EXECUTION_WORKING_DIR")),
		DefaultLintCommands:  splitCommands(os.Getenv("EXECUTION_LINT_COMMANDS")),
		DefaultTestCommands:  splitCommands(os.Getenv("EXECUTION_TEST_COMMANDS")),
		CodexCommand:         envOr("EXECUTION_CODEX_COMMAND", defaultCodexCommand),
		CodexArgs:            splitArgsOrDefault(os.Getenv("EXECUTION_CODEX_ARGS"), []string{"exec"}),
		CodexPromptMode:      envOr("EXECUTION_CODEX_PROMPT_MODE", defaultCodexPromptMode),
		CommandTimeout:       durationOr("EXECUTION_COMMAND_TIMEOUT", 10*time.Minute),
		CodexTimeout:         durationOr("EXECUTION_CODEX_TIMEOUT", 30*time.Minute),
		TaskTimeout:          durationOr("EXECUTION_TASK_TIMEOUT", 45*time.Minute),
		GitTimeout:           durationOr("EXECUTION_GIT_TIMEOUT", 5*time.Minute),
		JiraRequestTimeout:   durationOr("EXECUTION_JIRA_TIMEOUT", 30*time.Second),
		ClaimTimeout:         durationOr("EXECUTION_CLAIM_TIMEOUT", 15*time.Second),
		JiraBaseURL:          strings.TrimRight(strings.TrimSpace(os.Getenv("EXECUTION_JIRA_BASE_URL")), "/"),
		JiraProjectKey:       strings.TrimSpace(os.Getenv("EXECUTION_JIRA_PROJECT_KEY")),
		JiraReadyLabel:       envOr("EXECUTION_JIRA_READY_LABEL", defaultReadyLabel),
		JiraPollPageSize:     intOr("EXECUTION_JIRA_PAGE_SIZE", 10),
		JiraEmail:            strings.TrimSpace(os.Getenv("EXECUTION_JIRA_EMAIL")),
		JiraAPIToken:         strings.TrimSpace(os.Getenv("EXECUTION_JIRA_API_TOKEN")),
		JiraBearerToken:      strings.TrimSpace(os.Getenv("EXECUTION_JIRA_BEARER_TOKEN")),
		JiraInProgressStatus: strings.TrimSpace(os.Getenv("EXECUTION_JIRA_IN_PROGRESS_STATUS")),
		JiraEvaluationStatus: strings.TrimSpace(os.Getenv("EXECUTION_JIRA_EVALUATION_STATUS")),
		JiraDoneStatus:       strings.TrimSpace(os.Getenv("EXECUTION_JIRA_DONE_STATUS")),
		JiraFailedStatus:     strings.TrimSpace(os.Getenv("EXECUTION_JIRA_FAILED_STATUS")),
	}

	if cfg.MaxConcurrent < 1 {
		cfg.MaxConcurrent = 1
	}
	if cfg.MaxAttempts < 1 {
		cfg.MaxAttempts = 1
	}
	cfg.CodexPromptMode = strings.ToLower(cfg.CodexPromptMode)
	if cfg.CodexPromptMode != "stdin" && cfg.CodexPromptMode != "file" {
		return Config{}, fmt.Errorf("invalid EXECUTION_CODEX_PROMPT_MODE %q", cfg.CodexPromptMode)
	}

	var missing []string
	if cfg.DBDSN == "" {
		missing = append(missing, "EXECUTION_DB_DSN")
	}
	if cfg.JiraBaseURL == "" {
		missing = append(missing, "EXECUTION_JIRA_BASE_URL")
	}
	if cfg.JiraBearerToken == "" && (cfg.JiraEmail == "" || cfg.JiraAPIToken == "") {
		missing = append(missing, "EXECUTION_JIRA_EMAIL+EXECUTION_JIRA_API_TOKEN or EXECUTION_JIRA_BEARER_TOKEN")
	}
	if len(missing) > 0 {
		return Config{}, errors.New("missing required environment: " + strings.Join(missing, ", "))
	}

	return cfg, nil
}

func (c Config) JiraConfig() JiraClientConfig {
	return JiraClientConfig{
		BaseURL:        c.JiraBaseURL,
		ProjectKey:     c.JiraProjectKey,
		ReadyLabel:     c.JiraReadyLabel,
		Email:          c.JiraEmail,
		APIToken:       c.JiraAPIToken,
		BearerToken:    c.JiraBearerToken,
		RequestTimeout: c.JiraRequestTimeout,
	}
}

func envOr(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func intOr(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func durationOr(key string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func splitArgsOrDefault(raw string, fallback []string) []string {
	parts := splitCommands(raw)
	if len(parts) == 0 {
		return append([]string(nil), fallback...)
	}
	return parts
}

func splitCommands(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}

	if strings.HasPrefix(raw, "[") {
		var values []string
		if err := json.Unmarshal([]byte(raw), &values); err == nil {
			return clean(values)
		}
	}

	raw = strings.ReplaceAll(raw, "\r\n", "\n")
	raw = strings.ReplaceAll(raw, ";;", "\n")

	if strings.Contains(raw, "\n") {
		return clean(strings.Split(raw, "\n"))
	}

	return clean(strings.Fields(raw))
}

func clean(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		out = append(out, value)
	}
	return out
}

func hostnameOr(fallback string) string {
	name, err := os.Hostname()
	if err != nil || strings.TrimSpace(name) == "" {
		return fallback
	}
	return name
}

func findRepoRoot(start string) string {
	current := start
	for {
		if _, err := os.Stat(filepath.Join(current, ".git")); err == nil {
			return current
		}
		parent := filepath.Dir(current)
		if parent == current {
			return ""
		}
		current = parent
	}
}
