"use client";

import Link from "next/link";
import { useState } from "react";

import { AutonomyModeBadge } from "@/components/autonomy-mode-badge";
import { ConfidenceBadge } from "@/components/confidence-badge";
import { EmptyState } from "@/components/empty-state";
import { RiskBadge } from "@/components/risk-badge";
import { StatusBadge } from "@/components/status-badge";
import type { ProjectAutonomySummary } from "@/lib/autonomy";

function selectOptions(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function QueueSection({
  title,
  items
}: {
  title: string;
  items: Array<ProjectAutonomySummary["tasks"][number] & { projectId: string; projectName: string }>;
}) {
  return (
    <div className="surface-inline rounded-[26px] px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">{title}</p>
        <span className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
          {items.length}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-[rgb(var(--ink-soft))]">
          No tasks currently match this queue.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {items.slice(0, 5).map((item) => (
            <Link
              key={`${item.projectId}-${item.taskId}`}
              href={`/tasks/${item.taskId}`}
              className="block rounded-[22px] border border-[rgba(var(--line),0.88)] bg-white/75 px-4 py-4 transition hover:border-[rgba(var(--line-strong),0.95)]"
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">{item.title}</p>
                  <StatusBadge status={item.status} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <AutonomyModeBadge mode={item.mode} />
                  <ConfidenceBadge score={item.confidenceScore} band={item.confidenceBand} />
                  <RiskBadge risk={item.riskLevel} />
                </div>
                <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">{item.projectName}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function AutonomyOpsBoard({ projects }: { projects: ProjectAutonomySummary[] }) {
  const [projectFilter, setProjectFilter] = useState("all");
  const [modeFilter, setModeFilter] = useState("all");

  const flattenedTasks = projects.flatMap((project) =>
    project.tasks.map((task) => ({
      ...task,
      projectId: project.projectId,
      projectName: project.projectName
    }))
  );

  const filteredProjects = projects.filter((project) =>
    projectFilter === "all" ? true : project.projectId === projectFilter
  );

  const filteredTasks = flattenedTasks
    .filter((task) => (projectFilter === "all" ? true : task.projectId === projectFilter))
    .filter((task) => (modeFilter === "all" ? true : task.mode === modeFilter));

  const projectIds = selectOptions(projects.map((project) => project.projectId));
  const modes = selectOptions(flattenedTasks.map((task) => task.mode));
  const approvalQueue = filteredTasks.filter((task) => task.awaitingApproval);
  const autoExecuted = filteredTasks.filter((task) => task.autoExecuted);
  const blocked = filteredTasks.filter((task) => task.blockedByPolicy);
  const escalated = filteredTasks.filter((task) => task.escalatedToHuman);
  const highRiskCount = filteredTasks.filter((task) => task.riskLevel === "high").length;

  if (projects.length === 0) {
    return (
      <EmptyState
        title="No autonomy data available"
        body="Projects and task decision history need to be exposed before the operator overview can be computed."
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 xl:grid-cols-[repeat(2,minmax(0,220px))_minmax(0,1fr)_minmax(0,1fr)]">
        <label className="surface-inline rounded-[24px] px-4 py-4">
          <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">Project</p>
          <select
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
            className="mt-3 w-full border-0 bg-transparent text-sm font-semibold text-[rgb(var(--ink-strong))] outline-none"
          >
            <option value="all">All projects</option>
            {projectIds.map((projectId) => {
              const projectName = projects.find((project) => project.projectId === projectId)?.projectName || projectId;
              return (
                <option key={projectId} value={projectId}>
                  {projectName}
                </option>
              );
            })}
          </select>
        </label>

        <label className="surface-inline rounded-[24px] px-4 py-4">
          <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">Mode</p>
          <select
            value={modeFilter}
            onChange={(event) => setModeFilter(event.target.value)}
            className="mt-3 w-full border-0 bg-transparent text-sm font-semibold text-[rgb(var(--ink-strong))] outline-none"
          >
            <option value="all">All modes</option>
            {modes.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </label>

        <div className="surface-inline rounded-[24px] px-4 py-4">
          <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">Approval queue</p>
          <p className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-[rgb(var(--ink-strong))]">
            {approvalQueue.length}
          </p>
        </div>

        <div className="surface-inline rounded-[24px] px-4 py-4">
          <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">High risk tasks</p>
          <p className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-[rgb(var(--ink-strong))]">
            {highRiskCount}
          </p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="surface-inline rounded-[28px] px-5 py-5">
          <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
            Project autonomy overview
          </p>
          <div className="mt-4 space-y-3">
            {filteredProjects.map((project) => (
              <Link
                key={project.projectId}
                href={`/projects/${project.projectId}`}
                className="block rounded-[22px] border border-[rgba(var(--line),0.88)] bg-white/75 px-4 py-4 transition hover:border-[rgba(var(--line-strong),0.95)]"
              >
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="space-y-2">
                    <p className="text-base font-semibold text-[rgb(var(--ink-strong))]">{project.projectName}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <ConfidenceBadge score={project.confidenceAverage} />
                      <span className="rounded-full border border-[rgba(var(--line),0.92)] bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[rgb(var(--ink-strong))]">
                        {project.taskCount} tasks
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-amber-800">
                      Approval {project.awaitingApprovalCount}
                    </span>
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-800">
                      Auto {project.autoExecutedCount}
                    </span>
                    <span className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-rose-800">
                      Blocked {project.blockedCount}
                    </span>
                    <span className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-violet-800">
                      Escalated {project.escalatedCount}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <QueueSection title="Awaiting approval" items={approvalQueue} />
          <QueueSection title="Auto-executed" items={autoExecuted} />
          <QueueSection title="Blocked by policy" items={blocked} />
          <QueueSection title="Escalated to human" items={escalated} />
        </div>
      </div>
    </div>
  );
}
