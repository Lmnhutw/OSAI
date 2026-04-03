import { approvePlanAction, approveTaskAction } from "@/app/actions";
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
