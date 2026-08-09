import {
  createFollowUpTaskAction,
  escalateTaskAction,
  retryTaskAction,
  unblockTaskAction
} from "@/app/actions";
import { ActionButton } from "@/components/action-button";

function OperatorForm({
  action,
  taskId,
  planId,
  projectId,
  title,
  description,
  idleLabel,
  pendingLabel
}: {
  action: (formData: FormData) => Promise<void>;
  taskId: string;
  planId?: string;
  projectId?: string;
  title: string;
  description: string;
  idleLabel: string;
  pendingLabel: string;
}) {
  return (
    <form action={action} className="rounded-2xl border border-[rgb(var(--line))] bg-white/70 p-4">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="planId" value={planId || ""} />
      <input type="hidden" name="projectId" value={projectId || ""} />
      <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">{title}</p>
      <p className="mt-1 text-sm leading-6 text-[rgb(var(--ink-soft))]">{description}</p>
      <label className="mt-3 block text-sm font-medium text-[rgb(var(--ink-strong))]">
        Reason
        <input
          required
          minLength={3}
          name="reason"
          className="mt-1 w-full rounded-xl border border-[rgb(var(--line))] bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--focus))]"
        />
      </label>
      <div className="mt-3"><ActionButton idleLabel={idleLabel} pendingLabel={pendingLabel} variant="secondary" /></div>
    </form>
  );
}

export function TaskOperatorActions({ taskId, planId, projectId }: { taskId: string; planId?: string; projectId?: string }) {
  return (
    <details className="rounded-2xl border border-[rgb(var(--line))] bg-[rgba(var(--surface),0.7)] p-4">
      <summary className="cursor-pointer text-sm font-semibold text-[rgb(var(--ink-strong))]">
        More operator actions
      </summary>
      <p className="mt-2 text-sm leading-6 text-[rgb(var(--ink-soft))]">
        Every action is persisted and audited by the control plane.
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <OperatorForm action={retryTaskAction} taskId={taskId} planId={planId} projectId={projectId} title="Retry" description="Schedule a new attempt after a recorded failed result." idleLabel="Retry task" pendingLabel="Scheduling..." />
        <OperatorForm action={createFollowUpTaskAction} taskId={taskId} planId={planId} projectId={projectId} title="Follow-up" description="Create linked work with its own durable task record." idleLabel="Create follow-up" pendingLabel="Creating..." />
        <OperatorForm action={unblockTaskAction} taskId={taskId} planId={planId} projectId={projectId} title="Unblock" description="Revoke active task-level block overrides and re-evaluate." idleLabel="Unblock task" pendingLabel="Unblocking..." />
        <OperatorForm action={escalateTaskAction} taskId={taskId} planId={planId} projectId={projectId} title="Escalate" description="Hand ownership back to a human operator." idleLabel="Escalate task" pendingLabel="Escalating..." />
      </div>
    </details>
  );
}
