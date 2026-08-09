import Link from "next/link";

import { persistAutonomyOverrideAction } from "@/app/actions";
import { AutonomyModeBadge } from "@/components/autonomy-mode-badge";
import { ConfidenceBadge } from "@/components/confidence-badge";
import { RiskBadge } from "@/components/risk-badge";
import { StatusBadge } from "@/components/status-badge";
import type {
  AutonomyControlTimelineItem,
  DerivedAutonomySnapshot
} from "@/lib/autonomy";
import { cn, formatDateTime } from "@/lib/format";

function StatTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="surface-inline rounded-[24px] px-4 py-4">
      <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">{label}</p>
      <p className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-[rgb(var(--ink-strong))]">
        {value}
      </p>
      <p className="mt-2 text-sm leading-6 text-[rgb(var(--ink-soft))]">{detail}</p>
    </div>
  );
}

function timelineTone(kind: AutonomyControlTimelineItem["kind"]) {
  switch (kind) {
    case "policy":
    case "escalation":
      return "border-rose-200 bg-rose-50/80";
    case "override":
      return "border-violet-200 bg-violet-50/85";
    case "contract":
      return "border-sky-200 bg-sky-50/80";
    case "decision":
      return "border-emerald-200 bg-emerald-50/80";
    default:
      return "border-[rgba(var(--line),0.88)] bg-white/70";
  }
}

export function TaskControlTower({
  snapshot,
  timeline,
  planId,
  projectId
}: {
  snapshot: DerivedAutonomySnapshot;
  timeline: AutonomyControlTimelineItem[];
  planId?: string;
  projectId?: string;
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <AutonomyModeBadge mode={snapshot.mode} />
        <ConfidenceBadge score={snapshot.confidenceScore} band={snapshot.confidenceBand} />
        <RiskBadge risk={snapshot.riskLevel} />
        {snapshot.approvalRequired ? <StatusBadge status="awaiting_approval" /> : null}
        {snapshot.reviewRequired ? <StatusBadge status="review_required" /> : null}
        {snapshot.qaRequired ? <StatusBadge status="qa_pending" /> : null}
        {snapshot.escalatedToHuman ? <StatusBadge status="escalated" /> : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <StatTile
          label="Execution mode"
          value={snapshot.contract.executionMode}
          detail="Current autonomy posture after policy and any temporary operator override."
        />
        <StatTile
          label="Retry limit"
          value={String(snapshot.contract.retryLimit)}
          detail="Maximum retries currently available to the worker contract."
        />
        <StatTile
          label="Approval"
          value={snapshot.contract.approvalStatus}
          detail="Approval clearance for the current execution contract."
        />
        <StatTile
          label="Expires"
          value={formatDateTime(snapshot.contract.expirationAt)}
          detail="Contract expiration inferred from the most recent evaluation timeout."
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_360px]">
        <div className="space-y-6">
          <div className="surface-inline rounded-[28px] px-5 py-5">
            <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
              Decision summary
            </p>
            <p className="mt-3 text-base leading-7 text-[rgb(var(--ink-strong))]">
              {snapshot.decisionSummary}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {snapshot.allowedActions.map((action) => (
                <span
                  key={action}
                  className="rounded-full border border-[rgba(var(--line),0.92)] bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[rgb(var(--ink-strong))]"
                >
                  {action}
                </span>
              ))}
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <div className="surface-inline rounded-[28px] px-5 py-5">
              <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                Contributing factors
              </p>
              {snapshot.contributingFactors.length === 0 ? (
                <p className="mt-3 text-sm leading-6 text-[rgb(var(--ink-soft))]">
                  No contributing factors were exposed in the latest decision payloads.
                </p>
              ) : (
                <ul className="mt-3 space-y-2 text-sm leading-6 text-[rgb(var(--ink-strong))]">
                  {snapshot.contributingFactors.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </div>

            <div className="surface-inline rounded-[28px] px-5 py-5">
              <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                Evidence
              </p>
              {snapshot.evidence.length === 0 ? (
                <p className="mt-3 text-sm leading-6 text-[rgb(var(--ink-soft))]">
                  No direct evidence strings were attached to the current decision.
                </p>
              ) : (
                <ul className="mt-3 space-y-2 text-sm leading-6 text-[rgb(var(--ink-strong))]">
                  {snapshot.evidence.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <div className="surface-inline rounded-[28px] px-5 py-5">
              <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                Relevant history
              </p>
              {snapshot.historyRefs.length === 0 ? (
                <p className="mt-3 text-sm leading-6 text-[rgb(var(--ink-soft))]">
                  No prior failure or decision links were returned for this task.
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  {snapshot.historyRefs.map((ref) => (
                    <Link
                      key={ref.id}
                      href={ref.href}
                      className="block rounded-[22px] border border-[rgba(var(--line),0.88)] bg-white/70 px-4 py-4 transition hover:border-[rgba(var(--line-strong),0.95)]"
                    >
                      <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">{ref.label}</p>
                      <p className="mt-1 text-sm leading-6 text-[rgb(var(--ink-soft))]">{ref.detail}</p>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            <div className="surface-inline rounded-[28px] px-5 py-5">
              <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                Memory and sensitivity
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {snapshot.sensitiveScopeFlags.length === 0 ? (
                  <span className="text-sm text-[rgb(var(--ink-soft))]">No sensitivity warnings raised.</span>
                ) : (
                  snapshot.sensitiveScopeFlags.map((flag) => (
                    <span
                      key={flag}
                      className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-rose-800"
                    >
                      {flag}
                    </span>
                  ))
                )}
              </div>
              <div className="mt-4 space-y-3">
                {snapshot.memoryRefs.length === 0 ? (
                  <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">
                    No linked memory items are available for this task yet.
                  </p>
                ) : (
                  snapshot.memoryRefs.map((ref) => (
                    <Link
                      key={ref.id}
                      href={ref.href}
                      className="block rounded-[22px] border border-[rgba(var(--line),0.88)] bg-white/70 px-4 py-4 transition hover:border-[rgba(var(--line-strong),0.95)]"
                    >
                      <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">{ref.label}</p>
                      <p className="mt-1 text-sm leading-6 text-[rgb(var(--ink-soft))]">{ref.detail}</p>
                    </Link>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <form action={persistAutonomyOverrideAction} className="surface-inline rounded-[28px] px-5 py-5">
            <input type="hidden" name="taskId" value={snapshot.taskId} />
            <input type="hidden" name="planId" value={planId || ""} />
            <input type="hidden" name="projectId" value={projectId || ""} />
            <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
              Operator override
            </p>
            <p className="mt-2 text-sm leading-6 text-[rgb(var(--ink-soft))]">
              This records an auditable, persisted policy override. It is used by the next evaluation and execution contract; hard policy blocks still take precedence.
            </p>

            <div className="mt-4 space-y-3">
              <label className="block text-sm font-semibold text-[rgb(var(--ink-strong))]">
                Execution posture
                <select
                  name="mode"
                  defaultValue=""
                  className="mt-2 w-full rounded-xl border border-[rgb(var(--line))] bg-white px-3 py-2 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--focus))]"
                >
                  <option value="">Keep current policy posture</option>
                  <option value="review_required">Require manual review</option>
                  <option value="auto_execute" disabled={snapshot.blockedByPolicy || snapshot.approvalRequired}>
                    Allow automatic execution where policy permits
                  </option>
                  <option value="blocked">Block execution</option>
                </select>
              </label>
              <label className="flex items-start gap-3 text-sm text-[rgb(var(--ink-strong))]">
                <input name="disableRetries" type="checkbox" className="mt-1 h-4 w-4 accent-[rgb(var(--accent))]" />
                <span><strong>Disable retries.</strong> Persist zero retry budget for this task.</span>
              </label>
              <label className="flex items-start gap-3 text-sm text-[rgb(var(--ink-strong))]">
                <input name="markSensitive" type="checkbox" className="mt-1 h-4 w-4 accent-[rgb(var(--accent))]" />
                <span><strong>Mark as sensitive.</strong> Add an operator-managed sensitivity flag to policy evaluation.</span>
              </label>
              <label className="flex items-start gap-3 text-sm text-[rgb(var(--ink-strong))]">
                <input name="forceReview" type="checkbox" className="mt-1 h-4 w-4 accent-[rgb(var(--accent))]" />
                <span><strong>Force review checkpoint.</strong> Require human review even if mode is unchanged.</span>
              </label>
              <label className="block text-sm font-semibold text-[rgb(var(--ink-strong))]">
                Reason
                <textarea
                  name="reason"
                  required
                  rows={3}
                  placeholder="Why is this override necessary?"
                  className="mt-2 w-full rounded-xl border border-[rgb(var(--line))] bg-white px-3 py-2 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--focus))]"
                />
              </label>
            </div>

            <div className="mt-4">
              <button
                type="submit"
                className="inline-flex items-center justify-center rounded-full bg-[rgb(var(--accent))] px-4 py-2 text-sm font-medium text-white transition hover:bg-[rgba(var(--accent),0.92)]"
              >
                Save persisted override
              </button>
            </div>
          </form>
        </div>
      </div>

      <div className="surface-inline rounded-[28px] px-5 py-5">
        <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">Autonomy timeline</p>
        <div className="mt-4 space-y-3">
          {timeline.map((item) => (
            <div key={item.id} className={cn("rounded-[24px] border px-4 py-4", timelineTone(item.kind))}>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-1">
                  <p className="text-[11px] uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                    {item.kind}
                  </p>
                  <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">{item.title}</p>
                  <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">{item.description}</p>
                  {item.href ? (
                    <Link
                      href={item.href}
                      className="inline-flex text-sm font-medium text-[rgb(var(--accent))] transition hover:text-[rgb(var(--ink-strong))]"
                    >
                      Open linked evidence
                    </Link>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={item.status} />
                  <span className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                    {formatDateTime(item.time)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
