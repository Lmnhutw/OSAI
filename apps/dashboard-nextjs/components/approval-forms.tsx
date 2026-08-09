import { approvePlanAction, approveTaskAction, decidePlanApprovalAction } from "@/app/actions";
import { ActionButton } from "@/components/action-button";

interface PlanApprovalFormProps {
  planId: string;
  projectId?: string;
  disabled?: boolean;
}

export function PlanApprovalForm({
  planId,
  projectId,
  disabled = false
}: PlanApprovalFormProps) {
  return (
    <form action={approvePlanAction}>
      <input type="hidden" name="planId" value={planId} />
      <input type="hidden" name="projectId" value={projectId || ""} />
      <ActionButton
        idleLabel={disabled ? "Plan approved" : "Approve plan"}
        pendingLabel="Approving..."
        disabled={disabled}
      />
    </form>
  );
}

interface PlanApprovalDecisionFormProps {
  approvalId: string;
  planId: string;
  projectId?: string;
  expectedPlanUpdatedAt: string;
}

export function PlanApprovalDecisionForm({
  approvalId,
  planId,
  projectId,
  expectedPlanUpdatedAt
}: PlanApprovalDecisionFormProps) {
  return (
    <form action={decidePlanApprovalAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="approvalId" value={approvalId} />
      <input type="hidden" name="planId" value={planId} />
      <input type="hidden" name="projectId" value={projectId || ""} />
      <input type="hidden" name="expectedPlanUpdatedAt" value={expectedPlanUpdatedAt} />
      <input
        name="decisionNote"
        aria-label="Approval decision note"
        placeholder="Decision note (optional)"
        className="min-w-48 rounded-xl border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--ink-strong))] outline-none transition focus-visible:ring-2 focus-visible:ring-[rgb(var(--focus))]"
      />
      <ActionButton idleLabel="Approve" pendingLabel="Saving..." name="decision" value="approved" />
      <ActionButton idleLabel="Request changes" pendingLabel="Saving..." name="decision" value="changes_requested" />
      <ActionButton idleLabel="Reject" pendingLabel="Saving..." name="decision" value="rejected" />
    </form>
  );
}

interface TaskApprovalFormProps {
  taskId: string;
  planId?: string;
  projectId?: string;
  disabled?: boolean;
}

export function TaskApprovalForm({
  taskId,
  planId,
  projectId,
  disabled = false
}: TaskApprovalFormProps) {
  return (
    <form action={approveTaskAction}>
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="planId" value={planId || ""} />
      <input type="hidden" name="projectId" value={projectId || ""} />
      <ActionButton
        idleLabel={disabled ? "Task locked" : "Approve task"}
        pendingLabel="Approving..."
        disabled={disabled}
      />
    </form>
  );
}
