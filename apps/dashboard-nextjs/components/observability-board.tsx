"use client";

import Link from "next/link";
import { useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { EvaluationBadge } from "@/components/evaluation-badge";
import { RiskBadge } from "@/components/risk-badge";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime, sentenceCase } from "@/lib/format";

export interface ObservabilityItem {
  projectId: string;
  projectName: string;
  planId: string;
  planVersion: number;
  taskId: string;
  title: string;
  taskType: string;
  status: string;
  riskLevel: string;
  failureType: string;
  dispatchStatus: string;
  reviewStatus: string | null;
  qaStatus: string | null;
  latestRunId: string | null;
  latestRunStatus: string | null;
  changedFilesCount: number;
  updatedAt: string;
  latestActivityAt: string;
  errorSummary: string | null;
}

function selectOptions(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

export function ObservabilityBoard({ items }: { items: ObservabilityItem[] }) {
  const [statusFilter, setStatusFilter] = useState("all");
  const [riskFilter, setRiskFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [failureFilter, setFailureFilter] = useState("all");

  const filteredItems = items
    .filter((item) => (statusFilter === "all" ? true : item.status === statusFilter))
    .filter((item) => (riskFilter === "all" ? true : item.riskLevel === riskFilter))
    .filter((item) => (projectFilter === "all" ? true : item.projectId === projectFilter))
    .filter((item) => (failureFilter === "all" ? true : item.failureType === failureFilter))
    .sort((left, right) => right.latestActivityAt.localeCompare(left.latestActivityAt));

  const projects = selectOptions(items.map((item) => item.projectId));
  const statuses = selectOptions(items.map((item) => item.status));
  const risks = selectOptions(items.map((item) => item.riskLevel));
  const failures = selectOptions(items.map((item) => item.failureType));

  const highRiskCount = filteredItems.filter((item) => item.riskLevel === "high").length;
  const qaPendingCount = filteredItems.filter((item) => item.qaStatus === "qa_pending").length;
  const failedCount = filteredItems.filter((item) => item.failureType !== "none").length;

  return (
    <div className="space-y-5">
      <div className="grid gap-3 xl:grid-cols-[repeat(4,minmax(0,1fr))]">
        <label className="surface-inline rounded-[24px] px-4 py-4">
          <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">Status</p>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="mt-3 w-full border-0 bg-transparent text-sm font-semibold text-[rgb(var(--ink-strong))] outline-none"
          >
            <option value="all">All statuses</option>
            {statuses.map((status) => (
              <option key={status} value={status}>
                {sentenceCase(status)}
              </option>
            ))}
          </select>
        </label>

        <label className="surface-inline rounded-[24px] px-4 py-4">
          <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">Risk</p>
          <select
            value={riskFilter}
            onChange={(event) => setRiskFilter(event.target.value)}
            className="mt-3 w-full border-0 bg-transparent text-sm font-semibold text-[rgb(var(--ink-strong))] outline-none"
          >
            <option value="all">All risk levels</option>
            {risks.map((risk) => (
              <option key={risk} value={risk}>
                {sentenceCase(risk)}
              </option>
            ))}
          </select>
        </label>

        <label className="surface-inline rounded-[24px] px-4 py-4">
          <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">Project</p>
          <select
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
            className="mt-3 w-full border-0 bg-transparent text-sm font-semibold text-[rgb(var(--ink-strong))] outline-none"
          >
            <option value="all">All projects</option>
            {projects.map((projectId) => {
              const projectName = items.find((item) => item.projectId === projectId)?.projectName || projectId;

              return (
                <option key={projectId} value={projectId}>
                  {projectName}
                </option>
              );
            })}
          </select>
        </label>

        <label className="surface-inline rounded-[24px] px-4 py-4">
          <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
            Failure type
          </p>
          <select
            value={failureFilter}
            onChange={(event) => setFailureFilter(event.target.value)}
            className="mt-3 w-full border-0 bg-transparent text-sm font-semibold text-[rgb(var(--ink-strong))] outline-none"
          >
            <option value="all">All failure types</option>
            {failures.map((failure) => (
              <option key={failure} value={failure}>
                {sentenceCase(failure)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="surface-inline rounded-[24px] px-4 py-4">
          <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
            Filtered tasks
          </p>
          <p className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-[rgb(var(--ink-strong))]">
            {filteredItems.length}
          </p>
        </div>
        <div className="surface-inline rounded-[24px] px-4 py-4">
          <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
            High risk
          </p>
          <p className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-[rgb(var(--ink-strong))]">
            {highRiskCount}
          </p>
        </div>
        <div className="surface-inline rounded-[24px] px-4 py-4">
          <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
            QA or failure signals
          </p>
          <p className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-[rgb(var(--ink-strong))]">
            {qaPendingCount + failedCount}
          </p>
        </div>
      </div>

      {filteredItems.length === 0 ? (
        <EmptyState
          title="No tasks match the current filters"
          body="Adjust the status, risk, project, or failure filters to widen the observability view."
        />
      ) : (
        <div className="space-y-3">
          {filteredItems.map((item) => (
            <article key={item.taskId} className="surface-inline rounded-[26px] px-4 py-4">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/tasks/${item.taskId}`}
                      className="text-base font-semibold text-[rgb(var(--ink-strong))] transition hover:text-[rgb(var(--accent))]"
                    >
                      {item.title}
                    </Link>
                    <span className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                      {item.projectName}
                    </span>
                    <span className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                      Plan v{item.planVersion}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={item.status} />
                    <RiskBadge risk={item.riskLevel} />
                    <EvaluationBadge label="Dispatch" status={item.dispatchStatus} />
                    <EvaluationBadge label="Review" status={item.reviewStatus} />
                    <EvaluationBadge label="QA" status={item.qaStatus} />
                  </div>
                  <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm leading-6 text-[rgb(var(--ink-soft))]">
                    <span>{sentenceCase(item.taskType)}</span>
                    <span>Failure {sentenceCase(item.failureType)}</span>
                    <span>{item.changedFilesCount} changed files</span>
                    <span>Updated {formatDateTime(item.updatedAt)}</span>
                  </div>
                  {item.errorSummary ? (
                    <p className="max-w-4xl text-sm leading-6 text-[rgb(var(--ink-strong))]">
                      {item.errorSummary}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  {item.latestRunId ? (
                    <Link
                      href={`/runs/${item.latestRunId}`}
                      className="inline-flex rounded-full border border-[rgb(var(--line))] px-3 py-2 text-sm font-medium text-[rgb(var(--ink-strong))] transition hover:border-[rgb(var(--line-strong))] hover:bg-white"
                    >
                      Open run
                    </Link>
                  ) : null}
                  <Link
                    href={`/projects/${item.projectId}`}
                    className="inline-flex rounded-full border border-[rgb(var(--line))] px-3 py-2 text-sm font-medium text-[rgb(var(--ink-strong))] transition hover:border-[rgb(var(--line-strong))] hover:bg-white"
                  >
                    Open project
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
