import "server-only";

import type {
  ApiResource,
  Approval,
  ApprovalInput,
  BatchTaskApproveInput,
  DispatchEvaluation,
  EventRecord,
  ExecutionRun,
  HealthStatus,
  Plan,
  ProjectMemory,
  Project,
  ProjectRequirement,
  ResultEvaluation,
  Task,
  TaskMemory,
  TaskDependency,
  TaskHistory,
  TaskSession
} from "@/lib/api/types";

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";

const controlPlaneBaseUrl = (
  process.env.CONTROL_PLANE_API_BASE_URL ||
  process.env.NEXT_PUBLIC_CONTROL_PLANE_API_BASE_URL ||
  DEFAULT_BASE_URL
).replace(/\/+$/, "");

function cloneFallback<T>(fallback: T) {
  if (typeof fallback === "object" && fallback !== null) {
    return structuredClone(fallback);
  }

  return fallback;
}

function resolveUrl(path: string) {
  return `${controlPlaneBaseUrl}${path}`;
}

function parsePayload(text: string) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function extractMessage(payload: unknown, text: string) {
  if (payload && typeof payload === "object" && "detail" in payload) {
    const detail = (payload as { detail?: unknown }).detail;

    if (typeof detail === "string" && detail.trim()) {
      return detail.trim();
    }
  }

  const trimmedText = text.trim();
  return trimmedText || "Unknown API error";
}

function buildResource<T>(
  data: T,
  path: string,
  state: ApiResource<T>["state"] = "ready",
  extras: Partial<ApiResource<T>> = {}
): ApiResource<T> {
  return {
    data,
    state,
    path,
    ...extras
  };
}

interface ReadOptions<T> {
  fallback: T;
  notFoundDetails?: string[];
}

async function readResource<T>(path: string, options: ReadOptions<T>): Promise<ApiResource<T>> {
  try {
    const response = await fetch(resolveUrl(path), {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      cache: "no-store"
    });

    const text = await response.text();
    const payload = parsePayload(text);

    if (response.ok) {
      return buildResource((payload as T) ?? cloneFallback(options.fallback), path);
    }

    const message = extractMessage(payload, text);

    if (response.status === 404) {
      if (
        options.notFoundDetails?.some(
          (detail) => detail.toLowerCase() === message.toLowerCase()
        )
      ) {
        return buildResource(cloneFallback(options.fallback), path, "not_found", {
          status: response.status,
          message
        });
      }

      return buildResource(cloneFallback(options.fallback), path, "missing", {
        status: response.status,
        message
      });
    }

    if (response.status === 405 || response.status === 501) {
      return buildResource(cloneFallback(options.fallback), path, "missing", {
        status: response.status,
        message
      });
    }

    return buildResource(cloneFallback(options.fallback), path, "error", {
      status: response.status,
      message
    });
  } catch (error) {
    return buildResource(cloneFallback(options.fallback), path, "offline", {
      message: error instanceof Error ? error.message : "Unable to reach control plane"
    });
  }
}

async function writeResource<T>(path: string, body: unknown) {
  const response = await fetch(resolveUrl(path), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    cache: "no-store",
    body: JSON.stringify(body)
  });

  const text = await response.text();
  const payload = parsePayload(text);

  if (!response.ok) {
    throw new Error(`POST ${path} failed (${response.status}): ${extractMessage(payload, text)}`);
  }

  return payload as T;
}

export const controlPlanePaths = {
  health: () => "/health",
  projects: () => "/projects",
  project: (projectId: string) => `/projects/${projectId}`,
  projectRequirements: (projectId: string) => `/projects/${projectId}/requirements`,
  projectPlans: (projectId: string) => `/projects/${projectId}/plans`,
  plan: (planId: string) => `/plans/${planId}`,
  planApprovals: (planId: string) => `/plans/${planId}/approvals`,
  planTasks: (planId: string) => `/plans/${planId}/tasks`,
  planRuns: (planId: string) => `/plans/${planId}/runs`,
  planApprove: (planId: string) => `/plans/${planId}/approve`,
  task: (taskId: string) => `/tasks/${taskId}`,
  taskDependencies: (taskId: string) => `/tasks/${taskId}/dependencies`,
  taskHistory: (taskId: string) => `/tasks/${taskId}/history`,
  taskSessions: (taskId: string) => `/tasks/${taskId}/sessions`,
  taskRuns: (taskId: string) => `/tasks/${taskId}/runs`,
  taskEvaluateDispatch: (taskId: string) => `/tasks/${taskId}/evaluate-dispatch`,
  tasksApproveBatch: () => "/tasks/batch/approve",
  session: (sessionId: string) => `/sessions/${sessionId}`,
  sessionEvents: (sessionId: string) => `/sessions/${sessionId}/events`,
  run: (runId: string) => `/runs/${runId}`,
  runEvents: (runId: string) => `/runs/${runId}/events`,
  runEvaluateResult: (runId: string) => `/runs/${runId}/evaluate-result`,
  projectMemory: (projectId: string) => `/memory/project/${projectId}`,
  taskMemory: (taskId: string) => `/memory/task/${taskId}`
};

export function emptyResource<T>(data: T, path: string) {
  return buildResource(data, path);
}

export function getHealth() {
  return readResource<HealthStatus | null>(controlPlanePaths.health(), {
    fallback: null
  });
}

export function listProjects() {
  return readResource<Project[]>(controlPlanePaths.projects(), {
    fallback: []
  });
}

export function getProject(projectId: string) {
  return readResource<Project | null>(controlPlanePaths.project(projectId), {
    fallback: null,
    notFoundDetails: ["Project not found"]
  });
}

export function listProjectRequirements(projectId: string) {
  return readResource<ProjectRequirement[]>(controlPlanePaths.projectRequirements(projectId), {
    fallback: []
  });
}

export function listProjectPlans(projectId: string) {
  return readResource<Plan[]>(controlPlanePaths.projectPlans(projectId), {
    fallback: []
  });
}

export function getPlan(planId: string) {
  return readResource<Plan | null>(controlPlanePaths.plan(planId), {
    fallback: null,
    notFoundDetails: ["Plan not found"]
  });
}

export function listPlanApprovals(planId: string) {
  return readResource<Approval[]>(controlPlanePaths.planApprovals(planId), {
    fallback: []
  });
}

export function listPlanTasks(planId: string) {
  return readResource<Task[]>(controlPlanePaths.planTasks(planId), {
    fallback: []
  });
}

export function listPlanRuns(planId: string) {
  return readResource<ExecutionRun[]>(controlPlanePaths.planRuns(planId), {
    fallback: []
  });
}

export function getTask(taskId: string) {
  return readResource<Task | null>(controlPlanePaths.task(taskId), {
    fallback: null,
    notFoundDetails: ["Task not found"]
  });
}

export function listTaskDependencies(taskId: string) {
  return readResource<TaskDependency[]>(controlPlanePaths.taskDependencies(taskId), {
    fallback: []
  });
}

export function getTaskHistory(taskId: string) {
  return readResource<TaskHistory>(
    controlPlanePaths.taskHistory(taskId),
    {
      fallback: {
        task_id: taskId,
        loop_state: null,
        relationships: [],
        loop_history: [],
        entries: []
      },
      notFoundDetails: ["Task not found"]
    }
  );
}

export function listTaskSessions(taskId: string) {
  return readResource<TaskSession[]>(controlPlanePaths.taskSessions(taskId), {
    fallback: []
  });
}

export function listTaskRuns(taskId: string) {
  return readResource<ExecutionRun[]>(controlPlanePaths.taskRuns(taskId), {
    fallback: []
  });
}

export function getTaskMemory(taskId: string) {
  return readResource<TaskMemory>(
    controlPlanePaths.taskMemory(taskId),
    {
      fallback: {
        task_id: taskId,
        project_id: "",
        summary: "No curated task memory exists yet.",
        entries: [],
        generated_at: null,
        source_event_id: null
      }
    }
  );
}

export function getTaskSession(sessionId: string) {
  return readResource<TaskSession | null>(controlPlanePaths.session(sessionId), {
    fallback: null,
    notFoundDetails: ["Task session not found", "Session not found"]
  });
}

export function listSessionEvents(sessionId: string) {
  return readResource<EventRecord[]>(controlPlanePaths.sessionEvents(sessionId), {
    fallback: []
  });
}

export function getRun(runId: string) {
  return readResource<ExecutionRun | null>(controlPlanePaths.run(runId), {
    fallback: null,
    notFoundDetails: ["Execution run not found", "Run not found"]
  });
}

export function listRunEvents(runId: string) {
  return readResource<EventRecord[]>(controlPlanePaths.runEvents(runId), {
    fallback: []
  });
}

export function getProjectMemory(projectId: string) {
  return readResource<ProjectMemory>(
    controlPlanePaths.projectMemory(projectId),
    {
      fallback: {
        project_id: projectId,
        summary: "No curated project memory exists yet.",
        entries: [],
        generated_at: null,
        source_event_id: null
      }
    }
  );
}

export function approvePlan(planId: string, input: ApprovalInput) {
  return writeResource<Approval>(controlPlanePaths.planApprove(planId), input);
}

export function approveTasks(input: BatchTaskApproveInput) {
  return writeResource<Task[]>(controlPlanePaths.tasksApproveBatch(), input);
}

export function evaluateTaskDispatch(taskId: string) {
  return writeResource<DispatchEvaluation>(controlPlanePaths.taskEvaluateDispatch(taskId), {});
}

export function evaluateRunResult(runId: string) {
  return writeResource<ResultEvaluation>(controlPlanePaths.runEvaluateResult(runId), {});
}
