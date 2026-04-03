import type { Task } from "@/lib/api/types";

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short"
});

export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function sentenceCase(value: string) {
  if (!value) {
    return "";
  }

  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (segment) => segment.toUpperCase());
}

export function truncateId(value?: string | null, size = 8) {
  if (!value) {
    return "unknown";
  }

  if (value.length <= size) {
    return value;
  }

  return `${value.slice(0, size)}…`;
}

export function formatDateTime(value?: string | null) {
  if (!value) {
    return "Not recorded";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return dateTimeFormatter.format(date);
}

export function formatDuration(start?: string | null, end?: string | null) {
  if (!start) {
    return "Not started";
  }

  const startedAt = new Date(start);
  const endedAt = end ? new Date(end) : new Date();

  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
    return "Unknown";
  }

  const milliseconds = Math.max(endedAt.getTime() - startedAt.getTime(), 0);
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours === 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${hours}h ${remainingMinutes}m`;
}

export function formatJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

const statusOrder = ["pending", "approved", "in_progress", "running", "completed", "failed"];

export function groupTasksByStatus(tasks: Task[]) {
  const groups = new Map<string, Task[]>();

  for (const task of tasks) {
    const key = task.status || "unknown";

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key)?.push(task);
  }

  return Array.from(groups.entries())
    .sort(([left], [right]) => {
      const leftIndex = statusOrder.indexOf(left);
      const rightIndex = statusOrder.indexOf(right);

      if (leftIndex === -1 && rightIndex === -1) {
        return left.localeCompare(right);
      }

      if (leftIndex === -1) {
        return 1;
      }

      if (rightIndex === -1) {
        return -1;
      }

      return leftIndex - rightIndex;
    })
    .map(([status, groupedTasks]) => ({
      status,
      tasks: groupedTasks.sort((left, right) => left.position - right.position)
    }));
}
