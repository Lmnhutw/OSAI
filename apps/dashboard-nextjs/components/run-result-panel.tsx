"use client";

import { useActionState } from "react";

import { evaluateRunResultAction, type EvaluationActionState } from "@/app/actions";
import { ActionButton } from "@/components/action-button";
import { EmptyState } from "@/components/empty-state";
import { EvaluationBadge } from "@/components/evaluation-badge";
import { RiskBadge } from "@/components/risk-badge";
import { StatusBadge } from "@/components/status-badge";
import type { ResultEvaluation } from "@/lib/api/types";

interface RunResultPanelProps {
  runId: string;
  taskId?: string;
  planId?: string;
  projectId?: string;
  initialEvaluation?: ResultEvaluation | null;
}

const initialState: EvaluationActionState<ResultEvaluation> = {
  evaluation: null,
  error: null
};

function PolicyCell({
  label,
  value
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="surface-inline rounded-2xl px-3 py-3">
      <p className="text-[11px] uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">{label}</p>
      <p className="mt-2 text-sm font-semibold text-[rgb(var(--ink-strong))]">{value}</p>
    </div>
  );
}

export function RunResultPanel({
  runId,
  taskId,
  planId,
  projectId,
  initialEvaluation = null
}: RunResultPanelProps) {
  const [state, formAction] = useActionState(evaluateRunResultAction, {
    ...initialState,
    evaluation: initialEvaluation
  });

  const evaluation = state.evaluation;

  return (
    <div className="space-y-5">
      <form action={formAction} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="runId" value={runId} />
        <input type="hidden" name="taskId" value={taskId || ""} />
        <input type="hidden" name="planId" value={planId || ""} />
        <input type="hidden" name="projectId" value={projectId || ""} />
        <ActionButton
          idleLabel={evaluation ? "Refresh result evaluation" : "Run result evaluation"}
          pendingLabel="Evaluating..."
          variant="secondary"
        />
        {evaluation ? <StatusBadge status={evaluation.status} /> : null}
      </form>

      {state.error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          {state.error}
        </div>
      ) : null}

      {!evaluation ? (
        <EmptyState
          title="Execution evaluation not loaded"
          body="Run the control-plane result evaluator to expose reviewer decisions, QA status, follow-up actions, and risk flags for this attempt."
        />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <RiskBadge risk={evaluation.risk_flags.length >= 3 ? "high" : evaluation.risk_flags.length > 0 ? "medium" : "low"} />
            <EvaluationBadge label="Review" status={evaluation.reviewer_decision.status} />
            <EvaluationBadge label="QA" status={evaluation.qa_decision.status} />
            <EvaluationBadge label="Result" status={evaluation.status} />
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <PolicyCell
              label="Auto execute"
              value={evaluation.policy_decision.allow_auto_execute ? "Allowed" : "Held"}
            />
            <PolicyCell
              label="Approval gate"
              value={evaluation.policy_decision.require_approval ? "Required" : "Clear"}
            />
            <PolicyCell
              label="Escalation"
              value={evaluation.policy_decision.escalate ? "Required" : "Not required"}
            />
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <div className="space-y-3">
              <div className="surface-inline rounded-[24px] px-4 py-4">
                <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                  Reviewer decision
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <StatusBadge status={evaluation.reviewer_decision.status} />
                  {evaluation.reviewer_decision.scope_deviation ? (
                    <span className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-rose-800">
                      Scope deviation
                    </span>
                  ) : null}
                </div>
                <div className="mt-4 space-y-3 text-sm leading-6 text-[rgb(var(--ink-strong))]">
                  <p>
                    Matched criteria:{" "}
                    {evaluation.reviewer_decision.matched_acceptance_criteria.length}
                  </p>
                  <p>
                    Unmet criteria:{" "}
                    {evaluation.reviewer_decision.unmet_acceptance_criteria.length}
                  </p>
                  {evaluation.reviewer_decision.risky_changes.length > 0 ? (
                    <ul className="space-y-2">
                      {evaluation.reviewer_decision.risky_changes.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : null}
                  {evaluation.reviewer_decision.notes.length > 0 ? (
                    <ul className="space-y-2 text-[rgb(var(--ink-soft))]">
                      {evaluation.reviewer_decision.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="surface-inline rounded-[24px] px-4 py-4">
                <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                  QA status
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <StatusBadge status={evaluation.qa_decision.status} />
                  <span className="text-sm text-[rgb(var(--ink-soft))]">
                    {evaluation.qa_decision.validation_checks.length} validation checks
                  </span>
                </div>
                <div className="mt-4 space-y-3 text-sm leading-6 text-[rgb(var(--ink-strong))]">
                  {evaluation.qa_decision.missing_checks.length > 0 ? (
                    <ul className="space-y-2">
                      {evaluation.qa_decision.missing_checks.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>No missing QA checks were reported.</p>
                  )}
                  {evaluation.qa_decision.potential_regressions.length > 0 ? (
                    <ul className="space-y-2 text-[rgb(var(--ink-soft))]">
                      {evaluation.qa_decision.potential_regressions.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          <div className="surface-inline rounded-[24px] px-4 py-4">
            <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
              Follow-up actions
            </p>
            {evaluation.follow_up_actions.length === 0 ? (
              <p className="mt-3 text-sm leading-6 text-[rgb(var(--ink-strong))]">
                No follow-up actions were returned.
              </p>
            ) : (
              <ul className="mt-3 space-y-2 text-sm leading-6 text-[rgb(var(--ink-strong))]">
                {evaluation.follow_up_actions.map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            )}
            {evaluation.risk_flags.length > 0 ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {evaluation.risk_flags.map((flag) => (
                  <span
                    key={flag}
                    className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-rose-800"
                  >
                    {flag.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
