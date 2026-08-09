import { generatePlanTasksAction, generateProjectPlanAction } from "@/app/actions";
import { ActionButton } from "@/components/action-button";

export function ProjectPlanGenerationForm({ projectId }: { projectId: string }) {
  return (
    <form action={generateProjectPlanAction}>
      <input type="hidden" name="projectId" value={projectId} />
      <ActionButton idleLabel="Generate plan" pendingLabel="Planning..." variant="secondary" />
    </form>
  );
}

export function PlanTaskGenerationForm({ planId, projectId }: { planId: string; projectId?: string }) {
  return (
    <form action={generatePlanTasksAction}>
      <input type="hidden" name="planId" value={planId} />
      <input type="hidden" name="projectId" value={projectId || ""} />
      <ActionButton idleLabel="Generate tasks" pendingLabel="Decomposing..." variant="secondary" />
    </form>
  );
}
