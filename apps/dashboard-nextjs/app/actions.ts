"use server";

import { revalidatePath } from "next/cache";

import { approvePlan, approveTasks } from "@/lib/api/control-plane";

const DEFAULT_APPROVER = "dashboard-operator";

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
