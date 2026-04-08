import type {
  EventRecord,
  ExecutionRun,
  QADecision,
  ResultEvaluation,
  ReviewerDecision,
  TaskSession
} from "@/lib/api/types";
import {
  collectFailureReasons,
  extractChangedFiles,
  extractValidationChecks
} from "@/lib/intelligence";
import { sentenceCase } from "@/lib/format";

export function ExecutionInsightsPanel({
  run,
  session,
  events,
  resultEvaluation,
  reviewerDecision,
  qaDecision
}: {
  run: ExecutionRun;
  session: TaskSession | null;
  events: EventRecord[];
  resultEvaluation: ResultEvaluation | null;
  reviewerDecision: ReviewerDecision | null;
  qaDecision: QADecision | null;
}) {
  const validationChecks = extractValidationChecks(resultEvaluation, run, session, events);
  const changedFiles = extractChangedFiles(run.output_payload);
  const failureReasons = collectFailureReasons(run, resultEvaluation, reviewerDecision, qaDecision);
  const loopDecision = resultEvaluation?.loop_decision || null;

  return (
    <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-4">
      <div className="surface-inline rounded-[24px] px-4 py-4">
        <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
          Test results
        </p>
        {validationChecks.length === 0 ? (
          <p className="mt-3 text-sm leading-6 text-[rgb(var(--ink-soft))]">
            No explicit validation checks were found in the run payloads or QA evaluation.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            {validationChecks.map((check) => (
              <div key={`${check.acceptance_criterion}-${check.status}`} className="rounded-2xl border border-[rgba(var(--line),0.88)] px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">
                    {check.acceptance_criterion}
                  </p>
                  <span className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                    {sentenceCase(check.status)}
                  </span>
                </div>
                {check.evidence ? (
                  <p className="mt-2 text-sm text-[rgb(var(--ink-soft))]">{check.evidence}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="surface-inline rounded-[24px] px-4 py-4">
        <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
          Files changed
        </p>
        {changedFiles.length === 0 ? (
          <p className="mt-3 text-sm leading-6 text-[rgb(var(--ink-soft))]">
            No changed files were listed in the execution output.
          </p>
        ) : (
          <ul className="mt-3 space-y-2 font-mono text-xs leading-6 text-[rgb(var(--ink-strong))]">
            {changedFiles.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="surface-inline rounded-[24px] px-4 py-4">
        <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
          Failure reasons
        </p>
        {failureReasons.length === 0 ? (
          <p className="mt-3 text-sm leading-6 text-[rgb(var(--ink-soft))]">
            No failure reasons were detected for this execution attempt.
          </p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm leading-6 text-[rgb(var(--ink-strong))]">
            {failureReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="surface-inline rounded-[24px] px-4 py-4">
        <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
          Loop control
        </p>
        {!loopDecision ? (
          <p className="mt-3 text-sm leading-6 text-[rgb(var(--ink-soft))]">
            No loop decision was attached to this result evaluation.
          </p>
        ) : (
          <div className="mt-3 space-y-3 text-sm leading-6 text-[rgb(var(--ink-strong))]">
            <p>Next action: {sentenceCase(loopDecision.next_action)}</p>
            <p>Retry count: {loopDecision.retry_count}</p>
            <p>Loop depth: {loopDecision.chain_depth}</p>
            <p>
              Escalation: {loopDecision.requires_human ? "Human handoff required" : "Autonomous"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
