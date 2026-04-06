import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import type { ProjectMemory, TaskMemory } from "@/lib/api/types";
import {
  buildTaskSummaryItems,
  collectMemoryEntries,
  getBugPatternEntries,
  getImportantDecisionEntries
} from "@/lib/intelligence";
import { formatConfidence, formatDateTime } from "@/lib/format";

function MemorySection({
  title,
  description,
  defaultOpen = false,
  children
}: {
  title: string;
  description: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="surface-inline rounded-[24px]">
      <summary className="flex cursor-pointer items-start justify-between gap-4 px-4 py-4">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">{title}</p>
          <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">{description}</p>
        </div>
        <span className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
          Toggle
        </span>
      </summary>
      <div className="border-t border-[rgba(var(--line),0.88)] px-4 py-4">{children}</div>
    </details>
  );
}

function MemoryEntryList({ entries }: { entries: ProjectMemory["entries"] }) {
  if (entries.length === 0) {
    return (
      <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">
        No curated entries are available for this section yet.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {entries.map((entry) => (
        <article key={entry.dedupe_key} className="rounded-[22px] border border-[rgba(var(--line),0.88)] bg-white/70 px-4 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[rgba(var(--accent),0.08)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[rgb(var(--accent))]">
              {entry.source_type.replace(/_/g, " ")}
            </span>
            <span className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
              Impact {entry.decision_impact.replace(/_/g, " ")}
            </span>
            <span className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
              Confidence {formatConfidence(entry.confidence)}
            </span>
          </div>
          <p className="mt-3 text-sm font-semibold text-[rgb(var(--ink-strong))]">{entry.subject}</p>
          <p className="mt-2 text-sm leading-6 text-[rgb(var(--ink-strong))]">{entry.summary}</p>
          {entry.constraints.length > 0 ? (
            <ul className="mt-3 space-y-1 text-sm leading-6 text-[rgb(var(--ink-soft))]">
              {entry.constraints.map((constraint) => (
                <li key={constraint}>{constraint}</li>
              ))}
            </ul>
          ) : null}
          {entry.evidence_refs.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {entry.evidence_refs.map((ref, index) => (
                <span
                  key={`${entry.dedupe_key}-${ref.source_type}-${index}`}
                  className="rounded-full border border-[rgba(var(--line),0.88)] px-3 py-1 text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]"
                >
                  {ref.source_type}
                </span>
              ))}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

export function ProjectMemoryPanel({
  projectId,
  projectMemory,
  taskMemories
}: {
  projectId: string;
  projectMemory: ProjectMemory | null;
  taskMemories: TaskMemory[];
}) {
  const taskSummaries = buildTaskSummaryItems(taskMemories);
  const combinedEntries = collectMemoryEntries(projectMemory, null, taskMemories);
  const importantDecisions = getImportantDecisionEntries(combinedEntries);
  const bugPatterns = getBugPatternEntries(combinedEntries);

  if (!projectMemory && taskSummaries.length === 0) {
    return (
      <EmptyState
        title="No memory returned"
        body="Project canonical memory and curated task summaries will appear here once the control plane has produced them."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="surface-inline rounded-[24px] px-4 py-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
              Project canonical memory
            </p>
            <p className="text-sm leading-6 text-[rgb(var(--ink-strong))]">
              {projectMemory?.summary || "No curated project memory exists yet."}
            </p>
          </div>
          <p className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
            Generated {formatDateTime(projectMemory?.generated_at)}
          </p>
        </div>
      </div>

      <MemorySection
        title="Canonical memory"
        description="Reusable constraints, stable facts, and decision context curated at the project level."
        defaultOpen
      >
        <MemoryEntryList entries={projectMemory?.entries || []} />
      </MemorySection>

      <MemorySection
        title="Task summaries"
        description="Curated summaries from task-level memory that help operators scan recent execution learnings."
      >
        {taskSummaries.length === 0 ? (
          <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">
            No curated task summaries are available yet.
          </p>
        ) : (
          <div className="space-y-3">
            {taskSummaries.map((summary) => (
              <Link
                key={summary.taskId}
                href={`/tasks/${summary.taskId}`}
                className="block rounded-[22px] border border-[rgba(var(--line),0.88)] bg-white/70 px-4 py-4 transition hover:border-[rgb(var(--line-strong))] hover:bg-white"
              >
                <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">
                      {summary.title || summary.taskId}
                    </p>
                    <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">{summary.summary}</p>
                  </div>
                  <div className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                    {summary.entryCount} entries
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </MemorySection>

      <MemorySection
        title="Important decisions"
        description="Policy gates, review notes, and reusable decisions that influence future execution."
      >
        <MemoryEntryList entries={importantDecisions} />
      </MemorySection>

      <MemorySection
        title="Bug patterns"
        description="Repeated failures, regressions, and artifact-level patterns worth carrying forward."
      >
        <MemoryEntryList entries={bugPatterns} />
      </MemorySection>

      <div className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
        Project {projectId}
      </div>
    </div>
  );
}

export function TaskMemoryPanel({
  taskMemory
}: {
  taskMemory: TaskMemory | null;
}) {
  const importantDecisions = getImportantDecisionEntries(taskMemory?.entries || []);
  const bugPatterns = getBugPatternEntries(taskMemory?.entries || []);

  if (!taskMemory) {
    return (
      <EmptyState
        title="No task memory returned"
        body="Task summaries, important decisions, and bug patterns will appear here once the control plane curates them."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="surface-inline rounded-[24px] px-4 py-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
              Task summary
            </p>
            <p className="text-sm leading-6 text-[rgb(var(--ink-strong))]">
              {taskMemory.summary || "No curated task memory exists yet."}
            </p>
          </div>
          <p className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
            Generated {formatDateTime(taskMemory.generated_at)}
          </p>
        </div>
      </div>

      <MemorySection
        title="Curated entries"
        description="The full task memory stream carried forward into dispatch, review, and QA."
        defaultOpen
      >
        <MemoryEntryList entries={taskMemory.entries} />
      </MemorySection>

      <MemorySection
        title="Important decisions"
        description="Decision-driving signals extracted from reviews, policies, and QA outcomes."
      >
        <MemoryEntryList entries={importantDecisions} />
      </MemorySection>

      <MemorySection
        title="Bug patterns"
        description="Failure and regression signals that should shape the next attempt."
      >
        <MemoryEntryList entries={bugPatterns} />
      </MemorySection>
    </div>
  );
}
