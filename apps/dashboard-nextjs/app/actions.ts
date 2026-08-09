"use server";

import { revalidatePath } from "next/cache";

import type { DispatchEvaluation, JiraSync, ResultEvaluation } from "@/lib/api/types";
import {
  approvePlan,
  approveTasks,
  createFollowUpTask,
  createTaskAutonomyOverride,
  decidePlanApproval,
  evaluateRunResult,
  evaluateTaskDispatch,
  generatePlanTasks,
  generateProjectPlan,
  escalateTask,
  retryTask,
  syncTaskToJira
  ,unblockTask
} from "@/lib/api/control-plane";

const DEFAULT_APPROVER = "dashboard-operator";

export interface EvaluationActionState<T> {
  evaluation: T | null;
  error: string | null;
}

function readRequiredField(formData: FormData, key: string) {
  const value = String(formData.get(key) ?? "").trim();

  if (!value) {
    throw new Error(`Missing required field: ${key}`);
  }

  return value;
}

export async function approvePlanAction(formData: FormData) {
  const planId = readRequiredField(formData, "planId");
  const projectId = String(formData.get("projectId") ?? "").trim();

  await approvePlan(planId, {
    requested_by: process.env.CONTROL_PLANE_APPROVER?.trim() || DEFAULT_APPROVER,
    decision_note: "Approved from the Phase 1 dashboard."
  });

  revalidatePath(`/plans/${planId}`);

  if (projectId) {
    revalidatePath(`/projects/${projectId}`);
  }
}

export async function decidePlanApprovalAction(formData: FormData) {
  const approvalId = readRequiredField(formData, "approvalId");
  const planId = readRequiredField(formData, "planId");
  const projectId = String(formData.get("projectId") ?? "").trim();
  const decision = readRequiredField(formData, "decision");
  const expectedPlanUpdatedAt = String(formData.get("expectedPlanUpdatedAt") ?? "").trim();

  if (!["approved", "rejected", "changes_requested"].includes(decision)) {
    throw new Error("Invalid plan approval decision.");
  }

  await decidePlanApproval(
    approvalId,
    {
      decision: decision as "approved" | "rejected" | "changes_requested",
      decision_note: String(formData.get("decisionNote") ?? "").trim() || undefined,
      expected_plan_updated_at: expectedPlanUpdatedAt || undefined,
      idempotency_key: `dashboard-decision:${approvalId}:${crypto.randomUUID()}`
    },
    process.env.CONTROL_PLANE_APPROVER?.trim() || DEFAULT_APPROVER
  );

  revalidatePath(`/plans/${planId}`);

  if (projectId) {
    revalidatePath(`/projects/${projectId}`);
  }
}

export async function generateProjectPlanAction(formData: FormData) {
  const projectId = readRequiredField(formData, "projectId");
  await generateProjectPlan(projectId, process.env.CONTROL_PLANE_APPROVER?.trim() || DEFAULT_APPROVER);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/work-queue");
}

export async function generatePlanTasksAction(formData: FormData) {
  const planId = readRequiredField(formData, "planId");
  const projectId = String(formData.get("projectId") ?? "").trim();
  await generatePlanTasks(planId, process.env.CONTROL_PLANE_APPROVER?.trim() || DEFAULT_APPROVER);
  revalidatePath(`/plans/${planId}`);
  if (projectId) revalidatePath(`/projects/${projectId}`);
}

export async function approveTaskAction(formData: FormData) {
  const taskId = readRequiredField(formData, "taskId");
  const planId = String(formData.get("planId") ?? "").trim();
  const projectId = String(formData.get("projectId") ?? "").trim();

  await approveTasks({
    task_ids: [taskId]
  }, process.env.CONTROL_PLANE_APPROVER?.trim() || DEFAULT_APPROVER);

  revalidatePath(`/tasks/${taskId}`);

  if (planId) {
    revalidatePath(`/plans/${planId}`);
  }

  if (projectId) {
    revalidatePath(`/projects/${projectId}`);
  }
}

export async function syncTaskToJiraAction(
  _previousState: EvaluationActionState<JiraSync>,
  formData: FormData
): Promise<EvaluationActionState<JiraSync>> {
  const taskId = readRequiredField(formData, "taskId");
  const planId = String(formData.get("planId") ?? "").trim();
  const projectId = String(formData.get("projectId") ?? "").trim();

  try {
    const sync = await syncTaskToJira(
      taskId,
      process.env.CONTROL_PLANE_APPROVER?.trim() || DEFAULT_APPROVER
    );
    revalidatePath(`/tasks/${taskId}`);
    if (planId) revalidatePath(`/plans/${planId}`);
    if (projectId) revalidatePath(`/projects/${projectId}`);
    return { evaluation: sync, error: null };
  } catch (error) {
    return {
      evaluation: null,
      error: error instanceof Error ? error.message : "Jira sync failed."
    };
  }
}

export async function persistAutonomyOverrideAction(formData: FormData) {
  const taskId = readRequiredField(formData, "taskId");
  const planId = String(formData.get("planId") ?? "").trim();
  const projectId = String(formData.get("projectId") ?? "").trim();
  const reason = readRequiredField(formData, "reason");
  const mode = String(formData.get("mode") ?? "").trim();

  if (mode && !["auto_execute", "review_required", "blocked"].includes(mode)) {
    throw new Error("Invalid autonomy override mode.");
  }

  await createTaskAutonomyOverride(
    taskId,
    {
      reason,
      force_autonomy_mode: mode as "auto_execute" | "review_required" | "blocked" | undefined,
      force_review: Boolean(formData.get("forceReview")),
      disable_retries: Boolean(formData.get("disableRetries")),
      sensitive_modules: formData.get("markSensitive") ? ["operator-marked-sensitive"] : []
    },
    process.env.CONTROL_PLANE_APPROVER?.trim() || DEFAULT_APPROVER
  );

  revalidatePath(`/tasks/${taskId}`);
  if (planId) revalidatePath(`/plans/${planId}`);
  if (projectId) revalidatePath(`/projects/${projectId}`);
  revalidatePath("/work-queue");
  revalidatePath("/observability");
}

function taskActionContext(formData: FormData) {
  return {
    taskId: readRequiredField(formData, "taskId"),
    planId: String(formData.get("planId") ?? "").trim(),
    projectId: String(formData.get("projectId") ?? "").trim(),
    reason: readRequiredField(formData, "reason")
  };
}

function revalidateTaskAction({ taskId, planId, projectId }: ReturnType<typeof taskActionContext>) {
  revalidatePath(`/tasks/${taskId}`);
  if (planId) revalidatePath(`/plans/${planId}`);
  if (projectId) revalidatePath(`/projects/${projectId}`);
  revalidatePath("/work-queue");
  revalidatePath("/observability");
}

export async function retryTaskAction(formData: FormData) {
  const context = taskActionContext(formData);
  await retryTask(context.taskId, context.reason, process.env.CONTROL_PLANE_APPROVER?.trim() || DEFAULT_APPROVER);
  revalidateTaskAction(context);
}

export async function createFollowUpTaskAction(formData: FormData) {
  const context = taskActionContext(formData);
  await createFollowUpTask(context.taskId, context.reason, process.env.CONTROL_PLANE_APPROVER?.trim() || DEFAULT_APPROVER);
  revalidateTaskAction(context);
}

export async function unblockTaskAction(formData: FormData) {
  const context = taskActionContext(formData);
  await unblockTask(context.taskId, context.reason, process.env.CONTROL_PLANE_APPROVER?.trim() || DEFAULT_APPROVER);
  revalidateTaskAction(context);
}

export async function escalateTaskAction(formData: FormData) {
  const context = taskActionContext(formData);
  await escalateTask(context.taskId, context.reason, process.env.CONTROL_PLANE_APPROVER?.trim() || DEFAULT_APPROVER);
  revalidateTaskAction(context);
}

export async function evaluateDispatchAction(
  _previousState: EvaluationActionState<DispatchEvaluation>,
  formData: FormData
): Promise<EvaluationActionState<DispatchEvaluation>> {
  const taskId = readRequiredField(formData, "taskId");
  const planId = String(formData.get("planId") ?? "").trim();
  const projectId = String(formData.get("projectId") ?? "").trim();

  try {
    const evaluation = await evaluateTaskDispatch(taskId);

    revalidatePath(`/tasks/${taskId}`);

    if (planId) {
      revalidatePath(`/plans/${planId}`);
    }

    if (projectId) {
      revalidatePath(`/projects/${projectId}`);
    }

    revalidatePath("/observability");

    return {
      evaluation,
      error: null
    };
  } catch (error) {
    return {
      evaluation: null,
      error: error instanceof Error ? error.message : "Dispatch evaluation failed."
    };
  }
}

export async function evaluateRunResultAction(
  _previousState: EvaluationActionState<ResultEvaluation>,
  formData: FormData
): Promise<EvaluationActionState<ResultEvaluation>> {
  const runId = readRequiredField(formData, "runId");
  const taskId = String(formData.get("taskId") ?? "").trim();
  const planId = String(formData.get("planId") ?? "").trim();
  const projectId = String(formData.get("projectId") ?? "").trim();

  try {
    const evaluation = await evaluateRunResult(runId);

    revalidatePath(`/runs/${runId}`);

    if (taskId) {
      revalidatePath(`/tasks/${taskId}`);
    }

    if (planId) {
      revalidatePath(`/plans/${planId}`);
    }

    if (projectId) {
      revalidatePath(`/projects/${projectId}`);
    }

    revalidatePath("/observability");

    return {
      evaluation,
      error: null
    };
  } catch (error) {
    return {
      evaluation: null,
      error: error instanceof Error ? error.message : "Result evaluation failed."
    };
  }
}
