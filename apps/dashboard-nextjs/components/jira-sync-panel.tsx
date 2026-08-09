"use client";

import { useActionState } from "react";

import { syncTaskToJiraAction, type EvaluationActionState } from "@/app/actions";
import { ActionButton } from "@/components/action-button";
import { StatusBadge } from "@/components/status-badge";
import type { JiraSync } from "@/lib/api/types";
import { formatDateTime } from "@/lib/format";

interface JiraSyncPanelProps {
  taskId: string;
  planId?: string;
  projectId?: string;
  initialSync: JiraSync | null;
}

const initialState: EvaluationActionState<JiraSync> = { evaluation: null, error: null };

export function JiraSyncPanel({ taskId, planId, projectId, initialSync }: JiraSyncPanelProps) {
  const [state, formAction] = useActionState(syncTaskToJiraAction, initialState);
  const sync = state.evaluation || initialSync;

  return (
    <div className="space-y-4">
      <form action={formAction} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="taskId" value={taskId} />
        <input type="hidden" name="planId" value={planId || ""} />
        <input type="hidden" name="projectId" value={projectId || ""} />
        <ActionButton
          idleLabel={sync?.sync_status === "synchronized" ? "Jira ticket synchronized" : "Create or retry Jira ticket"}
          pendingLabel="Synchronizing..."
          disabled={sync?.sync_status === "synchronized"}
          variant="secondary"
        />
        {sync ? <StatusBadge status={sync.sync_status} /> : null}
      </form>

      {state.error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">{state.error}</div>
      ) : null}

      {sync ? (
        <div className="surface-inline rounded-2xl px-4 py-4 text-sm text-[rgb(var(--ink-soft))]">
          {sync.external_issue_url ? (
            <a className="font-semibold text-[rgb(var(--accent))] hover:underline" href={sync.external_issue_url} target="_blank" rel="noreferrer">
              {sync.external_issue_key || "Open Jira issue"}
            </a>
          ) : (
            <p>{sync.error_message || "Jira sync has not created an issue yet."}</p>
          )}
          <p className="mt-2">Attempts: {sync.attempt_count} · Updated {formatDateTime(sync.updated_at)}</p>
        </div>
      ) : (
        <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">No Jira ticket has been created for this task yet.</p>
      )}
    </div>
  );
}
