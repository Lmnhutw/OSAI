import Link from "next/link";

import { AutonomyModeBadge } from "@/components/autonomy-mode-badge";
import { ConfidenceBadge } from "@/components/confidence-badge";
import { EmptyState } from "@/components/empty-state";
import { RiskBadge } from "@/components/risk-badge";
import { StatusBadge } from "@/components/status-badge";
import type { ProjectAutonomySummary as ProjectAutonomySummaryData } from "@/lib/autonomy";

function SummaryTile({
  label,
  value,
  detail
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="surface-inline rounded-[24px] px-4 py-4">
      <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">{label}</p>
      <p className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-[rgb(var(--ink-strong))]">
        {value}
      </p>
      <p className="mt-2 text-sm leading-6 text-[rgb(var(--ink-soft))]">{detail}</p>
    </div>
  );
}

export function ProjectAutonomySummary({
  summary
}: {
  summary: ProjectAutonomySummaryData;
}) {
  if (summary.taskCount === 0) {
    return (
      <EmptyState
        title="No task autonomy data"
        body="Autonomy summaries will appear here once the latest plan exposes tasks and decision history."
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SummaryTile
          label="Avg confidence"
          value={`${Math.round(summary.confidenceAverage * 100)}%`}
          detail="Average operator confidence across the current plan."
        />
        <SummaryTile
          label="Awaiting approval"
          value={String(summary.awaitingApprovalCount)}
          detail="Tasks that need explicit human approval before autonomy can continue."
        />
        <SummaryTile
          label="Blocked by policy"
          value={String(summary.blockedCount)}
          detail="Tasks currently rejected by the autonomy contract."
        />
        <SummaryTile
          label="Escalated"
          value={String(summary.escalatedCount)}
          detail="Tasks already handed back to a human operator."
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <div className="surface-inline rounded-[26px] px-4 py-4">
          <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
            Risk distribution
          </p>
          <div className="mt-4 space-y-3">
            {(["high", "medium", "low", "unknown"] as const).map((risk) => (
              <div key={risk} className="space-y-2">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium text-[rgb(var(--ink-strong))]">{risk}</span>
                  <span className="text-[rgb(var(--ink-soft))]">{summary.riskDistribution[risk]}</span>
                </div>
                <div className="h-2 rounded-full bg-[rgba(var(--line),0.58)]">
                  <div
                    className={`h-2 rounded-full ${
                      risk === "high"
                        ? "bg-rose-500"
                        : risk === "medium"
                          ? "bg-amber-500"
                          : risk === "low"
                            ? "bg-emerald-500"
                            : "bg-slate-400"
                    }`}
                    style={{
                      width: `${summary.taskCount === 0 ? 0 : (summary.riskDistribution[risk] / summary.taskCount) * 100}%`
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          {summary.tasks.slice(0, 6).map((task) => (
            <article key={task.taskId} className="surface-inline rounded-[26px] px-4 py-4">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0 space-y-2">
                  <Link
                    href={`/tasks/${task.taskId}`}
                    className="text-base font-semibold text-[rgb(var(--ink-strong))] transition hover:text-[rgb(var(--accent))]"
                  >
                    {task.title}
                  </Link>
                  <div className="flex flex-wrap items-center gap-2">
                    <AutonomyModeBadge mode={task.mode} />
                    <ConfidenceBadge score={task.confidenceScore} band={task.confidenceBand} />
                    <RiskBadge risk={task.riskLevel} />
                    <StatusBadge status={task.status} />
                  </div>
                  <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">{task.summary}</p>
                  <div className="flex flex-wrap gap-2">
                    {task.sensitiveScopeFlags.map((flag) => (
                      <span
                        key={flag}
                        className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-rose-800"
                      >
                        {flag}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {task.awaitingApproval ? <StatusBadge status="awaiting_approval" /> : null}
                  {task.blockedByPolicy ? <StatusBadge status="dispatch_blocked" /> : null}
                  {task.escalatedToHuman ? <StatusBadge status="escalated" /> : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
