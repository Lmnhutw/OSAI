import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import type { ExecutionRun } from "@/lib/api/types";
import { formatDateTime, truncateId } from "@/lib/format";

interface RunsTableProps {
  runs: ExecutionRun[];
  emptyTitle: string;
  emptyBody: string;
}

export function RunsTable({ runs, emptyTitle, emptyBody }: RunsTableProps) {
  const sortedRuns = [...runs].sort((left, right) =>
    (right.started_at || right.created_at).localeCompare(left.started_at || left.created_at)
  );

  if (sortedRuns.length === 0) {
    return <EmptyState title={emptyTitle} body={emptyBody} />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-y-3">
        <thead>
          <tr className="text-left text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
            <th className="pb-2 pr-4 font-medium">Run</th>
            <th className="pb-2 pr-4 font-medium">Attempt</th>
            <th className="pb-2 pr-4 font-medium">Status</th>
            <th className="pb-2 pr-4 font-medium">Started</th>
            <th className="pb-2 pr-4 font-medium">Worker</th>
            <th className="pb-2 font-medium">Open</th>
          </tr>
        </thead>
        <tbody>
          {sortedRuns.map((run) => (
            <tr key={run.id} className="surface-inline rounded-2xl">
              <td className="rounded-l-2xl px-4 py-4 font-mono text-sm text-[rgb(var(--ink-strong))]">
                {truncateId(run.id, 12)}
              </td>
              <td className="px-4 py-4 text-sm text-[rgb(var(--ink-soft))]">{run.attempt_no}</td>
              <td className="px-4 py-4">
                <StatusBadge status={run.status} />
              </td>
              <td className="px-4 py-4 text-sm text-[rgb(var(--ink-soft))]">
                {formatDateTime(run.started_at || run.created_at)}
              </td>
              <td className="px-4 py-4 text-sm text-[rgb(var(--ink-soft))]">
                {run.worker_name || "Unassigned"}
              </td>
              <td className="rounded-r-2xl px-4 py-4">
                <Link
                  href={`/runs/${run.id}`}
                  className="inline-flex rounded-full border border-[rgb(var(--line))] px-3 py-2 text-sm font-medium text-[rgb(var(--ink-strong))] transition hover:border-[rgb(var(--line-strong))] hover:bg-white"
                >
                  Open run
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
