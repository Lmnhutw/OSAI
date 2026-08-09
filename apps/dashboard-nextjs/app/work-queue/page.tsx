import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { ResourceNotice } from "@/components/resource-notice";
import { SectionPanel } from "@/components/section-panel";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime, sentenceCase } from "@/lib/format";
import { getOperatorQueue } from "@/lib/api/control-plane";

export const dynamic = "force-dynamic";

export default async function WorkQueuePage() {
  const queue = await getOperatorQueue();

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operator control"
        title="Work queue"
        description="A server-derived queue of plans and tasks requiring a human decision. Nothing here is held only in browser state."
      />

      <ResourceNotice resources={[queue]} />

      <SectionPanel
        title={`${queue.data.total} actionable item${queue.data.total === 1 ? "" : "s"}`}
        description="Newest requests appear first. Open an item to inspect context and record a decision."
      >
        {queue.data.items.length === 0 ? (
          <EmptyState
            title="The operator queue is clear"
            body="New plan approvals and task review requests will appear here when the control plane records them."
          />
        ) : (
          <div className="divide-y divide-[rgba(var(--line),0.78)]">
            {queue.data.items.map((item) => {
              const href = item.task_id ? `/tasks/${item.task_id}` : `/plans/${item.plan_id}`;
              return (
                <Link
                  key={`${item.item_type}:${item.approval_id || item.task_id}`}
                  href={href}
                  className="grid gap-3 py-4 transition hover:bg-white/45 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[rgb(var(--ink-strong))]">{item.title}</p>
                    <p className="mt-1 text-sm text-[rgb(var(--ink-soft))]">
                      {sentenceCase(item.item_type.replace("_", " "))}
                      {item.requested_by ? ` · requested by ${item.requested_by}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 sm:justify-end">
                    <span className="text-xs text-[rgb(var(--ink-soft))]">{formatDateTime(item.created_at)}</span>
                    <StatusBadge status={item.status} />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </SectionPanel>
    </div>
  );
}
