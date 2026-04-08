import Link from "next/link";
import { notFound } from "next/navigation";

import { TaskApprovalForm } from "@/components/approval-forms";
import { CollapsibleLog } from "@/components/collapsible-log";
import { EventTimeline } from "@/components/event-timeline";
import { KeyValueGrid } from "@/components/key-value-grid";
import { TaskMemoryPanel } from "@/components/memory-panels";
import { PageHeader } from "@/components/page-header";
import { ResourceNotice } from "@/components/resource-notice";
import { RunsTable } from "@/components/runs-table";
import { SectionPanel } from "@/components/section-panel";
import { StatusBadge } from "@/components/status-badge";
import { TaskAutonomyPanel } from "@/components/task-autonomy-panel";
import { TaskDispatchPanel } from "@/components/task-dispatch-panel";
import {
  emptyResource,
  getPlan,
  getTask,
  getTaskHistory,
  getTaskMemory,
  listPlanTasks,
  listSessionEvents,
  listTaskDependencies,
  listTaskRuns,
  listTaskSessions
} from "@/lib/api/control-plane";
import { formatDateTime, formatJson } from "@/lib/format";

export const dynamic = "force-dynamic";

interface TaskDetailPageProps {
  params: Promise<{
    id: string;
  }>;
}

export default async function TaskDetailPage({ params }: TaskDetailPageProps) {
  const { id } = await params;
  const task = await getTask(id);

  if (task.state === "not_found") {
    notFound();
  }

  const [plan, planTasks, dependencies, sessions, runs, taskHistory] = task.data
    ? await Promise.all([
        getPlan(task.data.plan_id),
        listPlanTasks(task.data.plan_id),
        listTaskDependencies(task.data.id),
        listTaskSessions(task.data.id),
        listTaskRuns(task.data.id),
        getTaskHistory(task.data.id)
      ])
    : [
        emptyResource(null, `/plans/${id}`),
        emptyResource([], `/plans/${id}/tasks`),
        emptyResource([], `/tasks/${id}/dependencies`),
        emptyResource([], `/tasks/${id}/sessions`),
        emptyResource([], `/tasks/${id}/runs`),
        emptyResource(
          {
            task_id: id,
            loop_state: null,
            relationships: [],
            loop_history: [],
            entries: []
          },
          `/tasks/${id}/history`
        )
      ];

  const sortedSessions = [...sessions.data].sort((left, right) =>
    right.started_at.localeCompare(left.started_at)
  );
  const latestSession = sortedSessions[0] ?? null;
  const sortedRuns = [...runs.data].sort((left, right) =>
    (right.started_at || right.created_at).localeCompare(left.started_at || left.created_at)
  );
  const sessionEvents = latestSession
    ? await listSessionEvents(latestSession.id)
    : emptyResource([], `/sessions/${id}/events`);
  const taskMemory = task.data
    ? await getTaskMemory(task.data.id)
    : emptyResource(
        {
          task_id: id,
          project_id: plan.data?.project_id || "",
          summary: "No curated task memory exists yet.",
          entries: [],
          generated_at: null,
          source_event_id: null
        },
        `/memory/task/${id}`
      );

  const taskLookup = new Map(planTasks.data.map((planTask) => [planTask.id, planTask]));
  if (task.data) {
    taskLookup.set(task.data.id, task.data);
  }

  const relationshipItems = task.data
    ? [
        ...dependencies.data.map((dependency) => ({
          key: `dependency-${dependency.id}`,
          taskId: dependency.depends_on_task_id,
          label: "Dependency",
          detail: `Blocks this task via ${dependency.dependency_type}.`,
          status: taskLookup.get(dependency.depends_on_task_id)?.status || "open"
        })),
        ...taskHistory.data.relationships
          .filter((relationship) => relationship.child_task_id === task.data?.id)
          .map((relationship) => ({
            key: `incoming-${relationship.id}`,
            taskId: relationship.parent_task_id,
            label: "Parent task",
            detail:
              relationship.relationship_type === "chain"
                ? "Feeds this task through an autonomous chain."
                : `Linked as ${relationship.relationship_type}.`,
            status: taskLookup.get(relationship.parent_task_id)?.status || "open"
          })),
        ...taskHistory.data.relationships
          .filter((relationship) => relationship.parent_task_id === task.data?.id)
          .map((relationship) => ({
            key: `outgoing-${relationship.id}`,
            taskId: relationship.child_task_id,
            label:
              relationship.relationship_type === "chain" ? "Chain task" : "Follow-up task",
            detail:
              relationship.relationship_type === "chain"
                ? "Spawned or activated as the next step in the loop."
                : `Created as a ${relationship.relationship_type} task.`,
            status: taskLookup.get(relationship.child_task_id)?.status || "open"
          }))
      ]
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Task detail"
        title={task.data?.title || "Task detail"}
        description={
          task.data?.instructions ||
          "Review task instructions, dependencies, sessions, execution runs, and session evidence."
        }
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {task.data ? <StatusBadge status={task.data.status} /> : null}
            {task.data ? (
              <TaskApprovalForm
                taskId={task.data.id}
                planId={task.data.plan_id}
                projectId={plan.data?.project_id}
                disabled={task.data.status !== "pending"}
              />
            ) : null}
          </div>
        }
      />

      <ResourceNotice
        resources={[task, plan, planTasks, dependencies, sessions, runs, taskHistory, sessionEvents, taskMemory]}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <SectionPanel
            title="Task overview"
            description="Core execution metadata for this task."
          >
            <KeyValueGrid
              items={[
                {
                  label: "Task ID",
                  value: (
                    <span className="font-mono text-sm text-[rgb(var(--ink-strong))]">
                      {task.data?.id || id}
                    </span>
                  )
                },
                {
                  label: "Plan",
                  value: plan.data ? (
                    <Link
                      href={`/plans/${plan.data.id}`}
                      className="font-medium text-[rgb(var(--accent))] transition hover:text-[rgb(var(--ink-strong))]"
                    >
                      {plan.data.title}
                    </Link>
                  ) : (
                    "Unavailable"
                  )
                },
                {
                  label: "Position",
                  value: task.data ? String(task.data.position) : "Unknown"
                },
                {
                  label: "Task type",
                  value: task.data?.task_type || "Unknown"
                },
                {
                  label: "Created",
                  value: formatDateTime(task.data?.created_at)
                },
                {
                  label: "Updated",
                  value: formatDateTime(task.data?.updated_at)
                }
              ]}
            />
          </SectionPanel>

          <SectionPanel
            title="Instructions"
            description="Execution brief passed to the worker."
          >
            <div className="surface-inline rounded-2xl px-4 py-4">
              <p className="whitespace-pre-wrap text-sm leading-7 text-[rgb(var(--ink-strong))]">
                {task.data?.instructions || "No task instructions returned."}
              </p>
            </div>
          </SectionPanel>

          <SectionPanel
            title="Dispatch evaluation"
            description="Invoke the control-plane evaluator to inspect readiness, policy gates, risk, and missing context."
          >
            {task.data ? (
              <TaskDispatchPanel
                taskId={task.data.id}
                planId={task.data.plan_id}
                projectId={plan.data?.project_id}
              />
            ) : null}
          </SectionPanel>

          <SectionPanel
            title="Autonomous execution"
            description="Timeline and graph views for retries, task chains, follow-up creation, and escalation points."
          >
            {task.data ? (
              <TaskAutonomyPanel
                task={task.data}
                planTasks={planTasks.data}
                dependencies={dependencies.data}
                sessions={sessions.data}
                runs={runs.data}
                history={taskHistory.data}
              />
            ) : null}
          </SectionPanel>

          <SectionPanel
            title="Execution runs"
            description="Attempts linked to this task across one or more sessions."
          >
            <RunsTable
              runs={sortedRuns}
              emptyTitle="No runs returned"
              emptyBody="Execution attempts will populate after the worker claims and finalizes the task."
            />
          </SectionPanel>

          <SectionPanel
            title="Session logs"
            description="Latest session event history rendered as collapsible payload logs."
          >
            <EventTimeline
              events={sessionEvents.data}
              emptyTitle="No session events returned"
              emptyBody="Session-level logs will appear once the API layer exposes event history for the latest task session."
            />
          </SectionPanel>
        </div>

        <div className="space-y-6">
          <SectionPanel
            title="Task memory"
            description="Curated task summary, important decisions, and bug patterns carried forward into future execution."
          >
            <TaskMemoryPanel taskMemory={taskMemory.data} />
          </SectionPanel>

          <SectionPanel
            title="Input payload"
            description="Structured input passed into execution for this task."
          >
            <CollapsibleLog title="Task input payload" subtitle="JSON payload captured on the task row" defaultOpen>
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-6 text-[rgb(var(--ink-strong))]">
                {formatJson(task.data?.input_payload ?? {})}
              </pre>
            </CollapsibleLog>
          </SectionPanel>

          <SectionPanel
            title="Task relationships"
            description="Dependencies, parent links, follow-ups, and chained tasks connected to this task."
          >
            {relationshipItems.length === 0 ? (
              <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">
                No relationships were returned for this task.
              </p>
            ) : (
              <ul className="space-y-3">
                {relationshipItems.map((relationship) => (
                  <li key={relationship.key} className="surface-inline rounded-2xl px-4 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <p className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                          {relationship.label}
                        </p>
                        <Link
                          href={`/tasks/${relationship.taskId}`}
                          className="text-sm font-semibold text-[rgb(var(--ink-strong))] transition hover:text-[rgb(var(--accent))]"
                        >
                          {taskLookup.get(relationship.taskId)?.title || relationship.taskId}
                        </Link>
                        <p className="text-sm text-[rgb(var(--ink-soft))]">
                          {relationship.detail}
                        </p>
                      </div>
                      <StatusBadge status={relationship.status} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionPanel>

          <SectionPanel
            title="Task sessions"
            description="Logical session threads created for this task."
          >
            {sortedSessions.length === 0 ? (
              <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">
                No task sessions were returned.
              </p>
            ) : (
              <div className="space-y-3">
                {sortedSessions.map((session) => (
                  <div key={session.id} className="surface-inline rounded-2xl px-4 py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <p className="font-mono text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                          {session.id}
                        </p>
                        <p className="text-sm text-[rgb(var(--ink-strong))]">
                          Started {formatDateTime(session.started_at)}
                        </p>
                        <p className="text-sm text-[rgb(var(--ink-soft))]">
                          Ended {formatDateTime(session.ended_at)}
                        </p>
                      </div>
                      <StatusBadge status={session.status} />
                    </div>
                    {session.artifact_path ? (
                      <p className="mt-3 font-mono text-xs text-[rgb(var(--ink-soft))]">
                        Artifact {session.artifact_path}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </SectionPanel>
        </div>
      </div>
    </div>
  );
}
