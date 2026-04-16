"use client";

import Link from "next/link";
import { useState } from "react";

import { AutonomyModeBadge } from "@/components/autonomy-mode-badge";
import { ConfidenceBadge } from "@/components/confidence-badge";
import { RiskBadge } from "@/components/risk-badge";
import { StatusBadge } from "@/components/status-badge";
import type {
  AutonomyControlTimelineItem,
  DerivedAutonomySnapshot,
  OperatorOverrideState
} from "@/lib/autonomy";
import { applyOperatorOverride, buildOverrideTimelineItem } from "@/lib/autonomy";
import { cn, formatDateTime } from "@/lib/format";

type OverrideDraft = Omit<OperatorOverrideState, "appliedAt">;

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

function ToggleRow({
  checked,
  disabled,
  title,
  description,
  onChange
}: {
  checked: boolean;
  disabled?: boolean;
  title: string;
  description: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-3 rounded-[22px] border px-4 py-4 transition",
        disabled
          ? "border-[rgba(var(--line),0.75)] bg-[rgba(255,255,255,0.42)] opacity-60"
          : checked
            ? "border-[rgba(var(--accent),0.35)] bg-[rgba(var(--accent),0.08)]"
            : "border-[rgba(var(--line),0.88)] bg-white/70"
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-4 w-4 accent-[rgb(var(--accent))]"
      />
      <div className="space-y-1">
        <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">{title}</p>
        <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">{description}</p>
      </div>
    </label>
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
  timeline
}: {
  snapshot: DerivedAutonomySnapshot;
  timeline: AutonomyControlTimelineItem[];
}) {
  const [draft, setDraft] = useState<OverrideDraft>({
    forceManualReview: false,
    forceAuto: false,
    disableRetries: false,
    markSensitive: false,
    blockExecution: false
  });
  const [appliedOverride, setAppliedOverride] = useState<OperatorOverrideState | null>(null);

  const effectiveSnapshot = applyOperatorOverride(snapshot, appliedOverride);
  const effectiveTimeline = appliedOverride
    ? [buildOverrideTimelineItem(appliedOverride, effectiveSnapshot), ...timeline].sort((left, right) =>
        (right.time || "").localeCompare(left.time || "")
      )
    : timeline;

  const canForceAuto = !snapshot.blockedByPolicy && !snapshot.approvalRequired;

  return (
    <div className="space-y-6">
      {appliedOverride ? (
        <div className="rounded-[24px] border border-violet-200 bg-violet-50 px-4 py-4 text-sm leading-6 text-violet-900">
          Temporary override is active in this browser session only. Refreshing the page clears it until a backend override endpoint exists.
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <AutonomyModeBadge mode={effectiveSnapshot.mode} />
        <ConfidenceBadge score={effectiveSnapshot.confidenceScore} band={effectiveSnapshot.confidenceBand} />
        <RiskBadge risk={effectiveSnapshot.riskLevel} />
        {effectiveSnapshot.approvalRequired ? <StatusBadge status="awaiting_approval" /> : null}
        {effectiveSnapshot.reviewRequired ? <StatusBadge status="review_required" /> : null}
        {effectiveSnapshot.qaRequired ? <StatusBadge status="qa_pending" /> : null}
        {effectiveSnapshot.escalatedToHuman ? <StatusBadge status="escalated" /> : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <StatTile
          label="Execution mode"
          value={effectiveSnapshot.contract.executionMode}
          detail="Current autonomy posture after policy and any temporary operator override."
        />
        <StatTile
          label="Retry limit"
          value={String(effectiveSnapshot.contract.retryLimit)}
          detail="Maximum retries currently available to the worker contract."
        />
        <StatTile
          label="Approval"
          value={effectiveSnapshot.contract.approvalStatus}
          detail="Approval clearance for the current execution contract."
        />
        <StatTile
          label="Expires"
          value={formatDateTime(effectiveSnapshot.contract.expirationAt)}
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
              {effectiveSnapshot.decisionSummary}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {effectiveSnapshot.allowedActions.map((action) => (
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
              {effectiveSnapshot.contributingFactors.length === 0 ? (
                <p className="mt-3 text-sm leading-6 text-[rgb(var(--ink-soft))]">
                  No contributing factors were exposed in the latest decision payloads.
                </p>
              ) : (
                <ul className="mt-3 space-y-2 text-sm leading-6 text-[rgb(var(--ink-strong))]">
                  {effectiveSnapshot.contributingFactors.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </div>

            <div className="surface-inline rounded-[28px] px-5 py-5">
              <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                Evidence
              </p>
              {effectiveSnapshot.evidence.length === 0 ? (
                <p className="mt-3 text-sm leading-6 text-[rgb(var(--ink-soft))]">
                  No direct evidence strings were attached to the current decision.
                </p>
              ) : (
                <ul className="mt-3 space-y-2 text-sm leading-6 text-[rgb(var(--ink-strong))]">
                  {effectiveSnapshot.evidence.map((item) => (
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
              {effectiveSnapshot.historyRefs.length === 0 ? (
                <p className="mt-3 text-sm leading-6 text-[rgb(var(--ink-soft))]">
                  No prior failure or decision links were returned for this task.
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  {effectiveSnapshot.historyRefs.map((ref) => (
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
                {effectiveSnapshot.sensitiveScopeFlags.length === 0 ? (
                  <span className="text-sm text-[rgb(var(--ink-soft))]">No sensitivity warnings raised.</span>
                ) : (
                  effectiveSnapshot.sensitiveScopeFlags.map((flag) => (
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
                {effectiveSnapshot.memoryRefs.length === 0 ? (
                  <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">
                    No linked memory items are available for this task yet.
                  </p>
                ) : (
                  effectiveSnapshot.memoryRefs.map((ref) => (
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
          <div className="surface-inline rounded-[28px] px-5 py-5">
            <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
              Operator override
            </p>
            <p className="mt-2 text-sm leading-6 text-[rgb(var(--ink-soft))]">
              These controls are temporary UI-level overrides. They help operators model the decision boundary before backend persistence is wired.
            </p>

            <div className="mt-4 space-y-3">
              <ToggleRow
                checked={draft.forceManualReview}
                title="Force manual review"
                description="Insert a human checkpoint before the task can continue."
                onChange={(checked) => setDraft((current) => ({ ...current, forceManualReview: checked }))}
              />
              <ToggleRow
                checked={draft.forceAuto}
                disabled={!canForceAuto}
                title="Force auto mode where allowed"
                description="Clear review holds only when the current policy does not require approval or a hard block."
                onChange={(checked) => setDraft((current) => ({ ...current, forceAuto: checked }))}
              />
              <ToggleRow
                checked={draft.disableRetries}
                title="Disable retries"
                description="Collapse the retry budget to zero for the current browser session."
                onChange={(checked) => setDraft((current) => ({ ...current, disableRetries: checked }))}
              />
              <ToggleRow
                checked={draft.markSensitive}
                title="Mark task as sensitive"
                description="Add an operator sensitivity warning to the current decision surface."
                onChange={(checked) => setDraft((current) => ({ ...current, markSensitive: checked }))}
              />
              <ToggleRow
                checked={draft.blockExecution}
                title="Block execution"
                description="Move the working contract to a temporary operator block."
                onChange={(checked) => setDraft((current) => ({ ...current, blockExecution: checked }))}
              />
            </div>

            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => setAppliedOverride({ ...draft, appliedAt: new Date().toISOString() })}
                className="inline-flex items-center justify-center rounded-full bg-[rgb(var(--accent))] px-4 py-2 text-sm font-medium text-white transition hover:bg-[rgba(var(--accent),0.92)]"
              >
                Apply temporary override
              </button>
              <button
                type="button"
                onClick={() => {
                  setAppliedOverride(null);
                  setDraft({
                    forceManualReview: false,
                    forceAuto: false,
                    disableRetries: false,
                    markSensitive: false,
                    blockExecution: false
                  });
                }}
                className="inline-flex items-center justify-center rounded-full border border-[rgb(var(--line))] bg-white px-4 py-2 text-sm font-medium text-[rgb(var(--ink-strong))] transition hover:border-[rgb(var(--line-strong))]"
              >
                Clear override
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="surface-inline rounded-[28px] px-5 py-5">
        <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">Autonomy timeline</p>
        <div className="mt-4 space-y-3">
          {effectiveTimeline.map((item) => (
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
