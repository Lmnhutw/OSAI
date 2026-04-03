import Link from "next/link";
import { notFound } from "next/navigation";

import { CollapsibleLog } from "@/components/collapsible-log";
import { EventTimeline } from "@/components/event-timeline";
import { KeyValueGrid } from "@/components/key-value-grid";
import { PageHeader } from "@/components/page-header";
import { ResourceNotice } from "@/components/resource-notice";
import { SectionPanel } from "@/components/section-panel";
import { StatusBadge } from "@/components/status-badge";
import {
  emptyResource,
  getRun,
  getTask,
  getTaskSession,
  listRunEvents,
  listSessionEvents
} from "@/lib/api/control-plane";
import { formatDateTime, formatDuration, formatJson } from "@/lib/format";

export const dynamic = "force-dynamic";

interface RunDetailPageProps {
  params: {
    id: string;
  };
}

export default async function RunDetailPage({ params }: RunDetailPageProps) {
  const run = await getRun(params.id);

  if (run.state === "not_found") {
    notFound();
  }

  const [session, runEvents] = run.data
    ? await Promise.all([getTaskSession(run.data.task_session_id), listRunEvents(run.data.id)])
    : [emptyResource(null, `/sessions/${params.id}`), emptyResource([], `/runs/${params.id}/events`)];

  const task = session.data ? await getTask(session.data.task_id) : emptyResource(null, `/tasks/${params.id}`);
  const sessionEvents = session.data
    ? await listSessionEvents(session.data.id)
    : emptyResource([], `/sessions/${params.id}/events`);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Execution run"
        title={task.data?.title || `Run ${params.id}`}
        description="Inspect run payloads, error state, and the session evidence captured around this execution attempt."
        actions={run.data ? <StatusBadge status={run.data.status} /> : null}
      />

      <ResourceNotice resources={[run, session, task, runEvents, sessionEvents]} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <SectionPanel
            title="Run overview"
            description="Primary execution metadata for this run attempt."
          >
            <KeyValueGrid
              items={[
                {
                  label: "Run ID",
                  value: (
                    <span className="font-mono text-sm text-[rgb(var(--ink-strong))]">
                      {run.data?.id || params.id}
                    </span>
                  )
                },
                {
                  label: "Task",
                  value: task.data ? (
                    <Link
                      href={`/tasks/${task.data.id}`}
                      className="font-medium text-[rgb(var(--accent))] transition hover:text-[rgb(var(--ink-strong))]"
                    >
                      {task.data.title}
                    </Link>
                  ) : (
                    "Unavailable"
                  )
                },
                {
                  label: "Attempt",
                  value: run.data ? String(run.data.attempt_no) : "Unknown"
                },
                {
                  label: "Worker",
                  value: run.data?.worker_name || "Unassigned"
                },
                {
                  label: "Started",
                  value: formatDateTime(run.data?.started_at)
                },
                {
                  label: "Finished",
                  value: formatDateTime(run.data?.finished_at)
                },
                {
                  label: "Duration",
                  value: formatDuration(run.data?.started_at, run.data?.finished_at)
                }
              ]}
            />
          </SectionPanel>

          <SectionPanel
            title="Run events"
            description="Execution-run scoped events written by the worker."
          >
            <EventTimeline
              events={runEvents.data}
              emptyTitle="No run events returned"
              emptyBody="Run event history will appear here once the control-plane/API layer exposes execution event reads."
            />
          </SectionPanel>

          <SectionPanel
            title="Session log stream"
            description="Latest session event history associated with this run."
          >
            <EventTimeline
              events={sessionEvents.data}
              emptyTitle="No session logs returned"
              emptyBody="Session-level evidence will appear here once session event reads are available."
            />
          </SectionPanel>
        </div>

        <div className="space-y-6">
          <SectionPanel
            title="Run payloads"
            description="Input, output, and error payloads captured on the execution_runs row."
          >
            <div className="space-y-4">
              <CollapsibleLog title="Input payload" subtitle="Original execution input" defaultOpen>
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-6 text-[rgb(var(--ink-strong))]">
                  {formatJson(run.data?.input_payload ?? {})}
                </pre>
              </CollapsibleLog>

              <CollapsibleLog title="Output payload" subtitle="Final run output summary">
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-6 text-[rgb(var(--ink-strong))]">
                  {formatJson(run.data?.output_payload ?? {})}
                </pre>
              </CollapsibleLog>

              <CollapsibleLog title="Session metadata" subtitle="Session-level metadata captured at claim time">
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-6 text-[rgb(var(--ink-strong))]">
                  {formatJson(session.data?.metadata ?? {})}
                </pre>
              </CollapsibleLog>
            </div>
          </SectionPanel>

          <SectionPanel
            title="Failure signal"
            description="Error state and artifact paths associated with this run."
          >
            <div className="space-y-3 text-sm leading-6 text-[rgb(var(--ink-soft))]">
              <p>{run.data?.error_message || "No error message was recorded for this run."}</p>
              <p>
                Run artifact:{" "}
                <span className="font-mono text-xs text-[rgb(var(--ink-strong))]">
                  {run.data?.artifact_path || "Not recorded"}
                </span>
              </p>
              <p>
                Session artifact:{" "}
                <span className="font-mono text-xs text-[rgb(var(--ink-strong))]">
                  {session.data?.artifact_path || "Not recorded"}
                </span>
              </p>
            </div>
          </SectionPanel>
        </div>
      </div>
    </div>
  );
}
