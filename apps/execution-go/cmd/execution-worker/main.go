package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"execution-go/internal/artifact"
	"execution-go/internal/cli"
	"execution-go/internal/config"
	"execution-go/internal/jira"
	"execution-go/internal/runner"
	"execution-go/internal/store"
	"execution-go/internal/worker"
	"execution-go/internal/workspace"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		logger.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	executor := cli.NewExecutor()

	taskStore, err := store.NewPostgresStore(ctx, cfg.DBDSN)
	if err != nil {
		logger.Error("failed to connect to postgres", "error", err)
		os.Exit(1)
	}
	defer taskStore.Close()

	jiraClient := jira.NewClient(cfg.JiraConfig())
	workspaceManager := workspace.NewManager(cfg.WorkspaceRoot, cfg.DefaultRepoSource, cfg.GitTimeout, executor)
	codexRunner := runner.NewCodexRunner(cfg.CodexCommand, cfg.CodexArgs, cfg.CodexPromptMode, cfg.CodexTimeout, executor)
	qualityRunner := runner.NewQualityRunner(cfg.CommandTimeout, executor)
	artifactWriter := artifact.NewWriter(cfg.ArtifactRoot, cfg.RepoRoot)

	service := worker.NewService(cfg, logger, jiraClient, taskStore, workspaceManager, codexRunner, qualityRunner, artifactWriter)
	if err := service.Run(ctx); err != nil && err != context.Canceled {
		logger.Error("worker stopped with error", "error", err)
		os.Exit(1)
	}
}
