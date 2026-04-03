import { CollapsibleLog } from "@/components/collapsible-log";
import { EmptyState } from "@/components/empty-state";
import type { EventRecord } from "@/lib/api/types";
import { formatDateTime, formatJson } from "@/lib/format";

interface EventTimelineProps {
  events: EventRecord[];
  emptyTitle: string;
  emptyBody: string;
}

export function EventTimeline({ events, emptyTitle, emptyBody }: EventTimelineProps) {
  const sortedEvents = [...events].sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));

  if (sortedEvents.length === 0) {
    return <EmptyState title={emptyTitle} body={emptyBody} />;
  }

  return (
    <ol className="space-y-4">
      {sortedEvents.map((event) => (
        <li key={event.id} className="surface-inline rounded-[24px] px-4 py-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">
                {event.event_type}
              </p>
              <p className="text-sm text-[rgb(var(--ink-soft))]">{event.event_source}</p>
            </div>
            <div className="flex flex-wrap gap-3 text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
              <span>{formatDateTime(event.occurred_at)}</span>
              {event.artifact_path ? <span>{event.artifact_path}</span> : null}
            </div>
          </div>

          <div className="mt-4">
            <CollapsibleLog title="Event payload" subtitle="Structured event evidence">
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-6 text-[rgb(var(--ink-strong))]">
                {formatJson(event.payload)}
              </pre>
            </CollapsibleLog>
          </div>
        </li>
      ))}
    </ol>
  );
}
