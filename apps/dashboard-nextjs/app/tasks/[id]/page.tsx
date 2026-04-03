import Link from "next/link";
import { notFound } from "next/navigation";

import { TaskApprovalForm } from "@/components/approval-forms";
import { CollapsibleLog } from "@/components/collapsible-log";
import { EventTimeline } from "@/components/event-timeline";
import { KeyValueGrid } from "@/components/key-value-grid";
import { PageHeader } from "@/components/page-header";
import { ResourceNotice } from "@/components/resource-notice";
import { RunsTable } from "@/components/runs-table";
import { SectionPanel } from "@/components/section-panel";
import { StatusBadge } from "@/components/status-badge";
import {
  emptyResource,
  getPlan,
  getTask,
  listSessionEvents,
  listTaskDependencies,
  listTaskRuns,
  listTaskSessions
} from "@/lib/api/control-plane";
import { formatDateTime, formatJson } from "@/lib/format";

export const dynamic = "force-dynamic";

interface TaskDetailPageProps {
  params: {
    id: string;
  };
}

export default async function TaskDetailPage({ params }: TaskDetailPageProps) {
  const task = await getTask(params.id);

  if (task.state === "not_found") {
    notFound();
  }

  const [plan, dependencies, sessions, runs] = task.data
    ? await Promise.all([
        getPlan(task.data.plan_id),
        listTaskDependencies(task.data.id),
        listTaskSessions(task.data.id),
        listTaskRuns(task.data.id)
      ])
    : [
        emptyResource(null, `/plans/${params.id}`),
        emptyResource([], `/tasks/${params.id}/dependencies`),
        emptyResource([], `/tasks/${params.id}/sessions`),
        emptyResource([], `/tasks/${params.id}/runs`)
      ];

  const sortedSessions = [...sessions.data].sort((left, right) =>
    right.started_at.localeCompare(left.started_at)
  );
  const latestSession = sortedSessions[0] ?? null;
  const sessionEvents = latestSession
    ? await listSessionEvents(latestSession.id)
    : emptyResource([], `/sessions/${params.id}/events`);

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

      <ResourceNotice resources={[task, plan, dependencies, sessions, runs, sessionEvents]} />

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
                      {task.data?.id || params.id}
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
            title="Execution runs"
            description="Attempts linked to this task across one or more sessions."
          >
            <RunsTable
              runs={runs.data}
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
            title="Dependencies"
            description="Tasks that must complete before this task can move forward."
          >
            {dependencies.data.length === 0 ? (
              <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">
                No task dependencies were returned for this task.
              </p>
            ) : (
              <ul className="space-y-3">
                {dependencies.data.map((dependency) => (
                  <li key={dependency.id} className="surface-inline rounded-2xl px-4 py-4">
                    <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">
                      Blocks on task {dependency.depends_on_task_id}
                    </p>
                    <p className="mt-1 text-sm text-[rgb(var(--ink-soft))]">
                      Dependency type: {dependency.dependency_type}
                    </p>
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
