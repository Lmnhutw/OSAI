import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import type { Task } from "@/lib/api/types";
import { formatDateTime, groupTasksByStatus } from "@/lib/format";

export function TasksByStatus({ tasks }: { tasks: Task[] }) {
  const groupedTasks = groupTasksByStatus(tasks);

  if (groupedTasks.length === 0) {
    return (
      <EmptyState
        title="No tasks returned"
        body="Grouped task status will appear here once the API exposes plan or task read endpoints."
      />
    );
  }

  return (
    <div className="space-y-4">
      {groupedTasks.map((group) => (
        <div key={group.status} className="surface-inline rounded-[24px]">
          <div className="flex items-center justify-between gap-4 border-b border-[rgba(var(--line),0.88)] px-4 py-4">
            <div className="flex items-center gap-3">
              <StatusBadge status={group.status} />
              <p className="text-sm text-[rgb(var(--ink-soft))]">{group.tasks.length} tasks</p>
            </div>
          </div>
          <div className="divide-y divide-[rgba(var(--line),0.88)]">
            {group.tasks.map((task) => (
              <Link
                key={task.id}
                href={`/tasks/${task.id}`}
                className="block px-4 py-4 transition hover:bg-white/70"
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">
                      {task.position}. {task.title}
                    </p>
                    <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">
                      {task.instructions}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-4 text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                    <span>{task.task_type}</span>
                    <span>Updated {formatDateTime(task.updated_at)}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
