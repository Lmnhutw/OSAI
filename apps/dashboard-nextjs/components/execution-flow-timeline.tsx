import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import type { FlowItem } from "@/lib/intelligence";
import { formatDateTime } from "@/lib/format";

const kindLabel: Record<FlowItem["kind"], string> = {
  task: "Task",
  dispatch: "Dispatch",
  session: "Session",
  run: "Execution",
  retry: "Retry",
  review: "Review",
  qa: "QA"
};

export function ExecutionFlowTimeline({ items }: { items: FlowItem[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        title="No execution flow available"
        body="State transitions and retry loops will appear once the control plane records sessions, runs, and evaluation steps."
      />
    );
  }

  return (
    <ol className="space-y-4">
      {items.map((item, index) => (
        <li key={item.id} className="relative pl-8">
          {index < items.length - 1 ? (
            <span className="absolute left-[11px] top-7 h-[calc(100%+1rem)] w-px bg-[rgba(var(--line),0.92)]" />
          ) : null}
          <span className="absolute left-0 top-2 h-6 w-6 rounded-full border border-[rgba(var(--line-strong),0.92)] bg-white" />
          <div className="surface-inline rounded-[24px] px-4 py-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                  {kindLabel[item.kind]}
                  {item.attemptNo ? ` · Attempt ${item.attemptNo}` : ""}
                </p>
                <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">{item.label}</p>
                <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">{item.description}</p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <StatusBadge status={item.status} />
                <span className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                  {formatDateTime(item.time)}
                </span>
              </div>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
