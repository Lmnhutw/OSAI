"use client";

import { useActionState } from "react";

import { evaluateDispatchAction, type EvaluationActionState } from "@/app/actions";
import { ActionButton } from "@/components/action-button";
import { EmptyState } from "@/components/empty-state";
import { RiskBadge } from "@/components/risk-badge";
import { StatusBadge } from "@/components/status-badge";
import type { DispatchEvaluation } from "@/lib/api/types";

interface TaskDispatchPanelProps {
  taskId: string;
  planId?: string;
  projectId?: string;
  initialEvaluation?: DispatchEvaluation | null;
}

const initialState: EvaluationActionState<DispatchEvaluation> = {
  evaluation: null,
  error: null
};

function DecisionFlag({
  label,
  active,
  positiveLabel = "On",
  negativeLabel = "Off"
}: {
  label: string;
  active: boolean;
  positiveLabel?: string;
  negativeLabel?: string;
}) {
  return (
    <div className="surface-inline rounded-2xl px-3 py-3">
      <p className="text-[11px] uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">{label}</p>
      <p className="mt-2 text-sm font-semibold text-[rgb(var(--ink-strong))]">
        {active ? positiveLabel : negativeLabel}
      </p>
    </div>
  );
}

export function TaskDispatchPanel({
  taskId,
  planId,
  projectId,
  initialEvaluation = null
}: TaskDispatchPanelProps) {
  const [state, formAction] = useActionState(evaluateDispatchAction, {
    ...initialState,
    evaluation: initialEvaluation
  });

  const evaluation = state.evaluation;

  return (
    <div className="space-y-5">
      <form action={formAction} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="taskId" value={taskId} />
        <input type="hidden" name="planId" value={planId || ""} />
        <input type="hidden" name="projectId" value={projectId || ""} />
        <ActionButton
          idleLabel={evaluation ? "Refresh dispatch evaluation" : "Run dispatch evaluation"}
          pendingLabel="Evaluating..."
          variant="secondary"
        />
        {evaluation ? <StatusBadge status={evaluation.status} /> : null}
        {evaluation ? <RiskBadge risk={evaluation.risk_level} /> : null}
      </form>

      {state.error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          {state.error}
        </div>
      ) : null}

      {!evaluation ? (
        <EmptyState
          title="Dispatch evaluation not loaded"
          body="Run the control-plane dispatch evaluator to inspect readiness, missing context, acceptance criteria, and policy gates for this task."
        />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <DecisionFlag
              label="Auto execute"
              active={evaluation.policy_decision.allow_auto_execute}
            />
            <DecisionFlag
              label="Review gate"
              active={evaluation.policy_decision.require_review}
            />
            <DecisionFlag label="QA gate" active={evaluation.policy_decision.require_qa} />
            <DecisionFlag
              label="Approval gate"
              active={evaluation.policy_decision.require_approval}
            />
            <DecisionFlag label="Block" active={evaluation.policy_decision.block} />
            <DecisionFlag
              label="Retry budget"
              active={evaluation.policy_decision.retry_allowed}
              positiveLabel="Available"
              negativeLabel="Spent"
            />
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <div className="space-y-3">
              <div className="surface-inline rounded-[24px] px-4 py-4">
                <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                  Missing context
                </p>
                {evaluation.missing_context.length === 0 ? (
                  <p className="mt-3 text-sm leading-6 text-[rgb(var(--ink-strong))]">
                    No missing context was flagged by the evaluator.
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2 text-sm leading-6 text-[rgb(var(--ink-strong))]">
                    {evaluation.missing_context.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="surface-inline rounded-[24px] px-4 py-4">
                <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                  Dependencies
                </p>
                {evaluation.dependencies.length === 0 ? (
                  <p className="mt-3 text-sm leading-6 text-[rgb(var(--ink-strong))]">
                    No blocking dependencies were returned for this task.
                  </p>
                ) : (
                  <div className="mt-3 space-y-3">
                    {evaluation.dependencies.map((dependency) => (
                      <div key={`${dependency.task_id}-${dependency.dependency_type}`} className="rounded-2xl border border-[rgba(var(--line),0.88)] px-3 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">
                            {dependency.title}
                          </p>
                          <StatusBadge status={dependency.status} />
                        </div>
                        <p className="mt-2 text-sm text-[rgb(var(--ink-soft))]">
                          {dependency.dependency_type}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <div className="surface-inline rounded-[24px] px-4 py-4">
                <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                  Acceptance criteria
                </p>
                {evaluation.acceptance_criteria.length === 0 ? (
                  <p className="mt-3 text-sm leading-6 text-[rgb(var(--ink-strong))]">
                    The evaluator did not find explicit acceptance criteria.
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2 text-sm leading-6 text-[rgb(var(--ink-strong))]">
                    {evaluation.acceptance_criteria.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="surface-inline rounded-[24px] px-4 py-4">
                <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                  Constraints and risk flags
                </p>
                <div className="mt-3 space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {evaluation.risk_flags.length === 0 ? (
                      <span className="text-sm text-[rgb(var(--ink-strong))]">
                        No explicit risk flags were raised.
                      </span>
                    ) : (
                      evaluation.risk_flags.map((flag) => (
                        <span
                          key={flag}
                          className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-rose-800"
                        >
                          {flag.replace(/_/g, " ")}
                        </span>
                      ))
                    )}
                  </div>
                  <ul className="space-y-2 text-sm leading-6 text-[rgb(var(--ink-strong))]">
                    {evaluation.constraints.length === 0 ? (
                      <li>No constraints were captured in the evaluation output.</li>
                    ) : (
                      evaluation.constraints.map((constraint) => <li key={constraint}>{constraint}</li>)
                    )}
                  </ul>
                </div>
              </div>

              <div className="surface-inline rounded-[24px] px-4 py-4">
                <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                  Policy reason codes
                </p>
                {evaluation.policy_decision.reason_codes.length === 0 ? (
                  <p className="mt-3 text-sm leading-6 text-[rgb(var(--ink-strong))]">
                    No policy reason codes were returned.
                  </p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {evaluation.policy_decision.reason_codes.map((code) => (
                      <span
                        key={code}
                        className="rounded-full border border-[rgba(var(--line),0.92)] bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[rgb(var(--ink-strong))]"
                      >
                        {code.replace(/_/g, " ")}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
