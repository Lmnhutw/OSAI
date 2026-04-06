"use server";

import { revalidatePath } from "next/cache";

import type { DispatchEvaluation, ResultEvaluation } from "@/lib/api/types";
import {
  approvePlan,
  approveTasks,
  evaluateRunResult,
  evaluateTaskDispatch
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

export async function approveTaskAction(formData: FormData) {
  const taskId = readRequiredField(formData, "taskId");
  const planId = String(formData.get("planId") ?? "").trim();
  const projectId = String(formData.get("projectId") ?? "").trim();

  await approveTasks({
    task_ids: [taskId]
  });

  revalidatePath(`/tasks/${taskId}`);

  if (planId) {
    revalidatePath(`/plans/${planId}`);
  }

  if (projectId) {
    revalidatePath(`/projects/${projectId}`);
  }
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
