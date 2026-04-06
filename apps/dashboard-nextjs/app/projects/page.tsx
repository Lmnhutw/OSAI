import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { ResourceNotice } from "@/components/resource-notice";
import { SectionPanel } from "@/components/section-panel";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime, sentenceCase, truncateId } from "@/lib/format";
import { getHealth, listProjects } from "@/lib/api/control-plane";

export const dynamic = "force-dynamic";

function healthLabel(health: Awaited<ReturnType<typeof getHealth>>) {
  if (health.state === "ready" && health.data?.status) {
    return health.data.status;
  }

  if (health.state === "offline") {
    return "offline";
  }

  if (health.state === "missing") {
    return "missing";
  }

  if (health.state === "error") {
    return "degraded";
  }

  return "unknown";
}

export default async function ProjectsPage() {
  const [health, projects] = await Promise.all([getHealth(), listProjects()]);

  const sortedProjects = [...projects.data].sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at)
  );

  const activeCount = sortedProjects.filter(
    (project) => !["completed", "failed"].includes(project.status)
  ).length;
  const failedCount = sortedProjects.filter((project) => project.status === "failed").length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Phase 2 dashboard"
        title="Projects"
        description="Monitor project registry, plan progression, memory coverage, task state, execution runs, and drill-in evidence from a single operator surface."
        actions={
          <div className="surface-inline inline-flex items-center gap-3 rounded-full px-4 py-2 text-sm text-[rgb(var(--ink-soft))]">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                health.state === "ready"
                  ? "bg-emerald-600"
                  : health.state === "offline"
                    ? "bg-rose-600"
                    : "bg-amber-500"
              }`}
            />
            Control plane {sentenceCase(healthLabel(health))}
          </div>
        }
      />

      <ResourceNotice resources={[health, projects]} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <SectionPanel
          title="Project registry"
          description="Each project is the root entity for requirements, plans, tasks, sessions, runs, and event history."
        >
          {sortedProjects.length === 0 ? (
            <EmptyState
              title="No projects returned"
              body="Once the control plane exposes project rows, they will appear here with direct drill-in links."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full border-separate border-spacing-y-3">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                    <th className="pb-2 pr-4 font-medium">Project</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 pr-4 font-medium">Identifier</th>
                    <th className="pb-2 pr-4 font-medium">Updated</th>
                    <th className="pb-2 font-medium">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedProjects.map((project) => (
                    <tr key={project.id} className="surface-inline rounded-2xl">
                      <td className="rounded-l-2xl px-4 py-4 align-top">
                        <div className="space-y-1">
                          <p className="text-base font-semibold text-[rgb(var(--ink-strong))]">
                            {project.name}
                          </p>
                          <p className="max-w-xl text-sm leading-6 text-[rgb(var(--ink-soft))]">
                            {project.description || "No project description captured yet."}
                          </p>
                        </div>
                      </td>
                      <td className="px-4 py-4 align-top">
                        <StatusBadge status={project.status} />
                      </td>
                      <td className="px-4 py-4 align-top font-mono text-sm text-[rgb(var(--ink-soft))]">
                        {truncateId(project.id, 12)}
                      </td>
                      <td className="px-4 py-4 align-top text-sm text-[rgb(var(--ink-soft))]">
                        {formatDateTime(project.updated_at)}
                      </td>
                      <td className="rounded-r-2xl px-4 py-4 align-top">
                        <Link
                          href={`/projects/${project.id}`}
                          className="inline-flex rounded-full border border-[rgb(var(--line))] px-3 py-2 text-sm font-medium text-[rgb(var(--ink-strong))] transition hover:border-[rgb(var(--line-strong))] hover:bg-white"
                        >
                          Open project
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionPanel>

        <div className="space-y-6">
          <SectionPanel
            title="Live counts"
            description="High-signal status indicators for the current registry payload."
          >
            <div className="data-grid">
              <div className="surface-inline rounded-2xl p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                  Total projects
                </p>
                <p className="mt-3 text-3xl font-semibold text-[rgb(var(--ink-strong))]">
                  {sortedProjects.length}
                </p>
              </div>
              <div className="surface-inline rounded-2xl p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                  Active
                </p>
                <p className="mt-3 text-3xl font-semibold text-[rgb(var(--ink-strong))]">
                  {activeCount}
                </p>
              </div>
              <div className="surface-inline rounded-2xl p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                  Failed
                </p>
                <p className="mt-3 text-3xl font-semibold text-[rgb(var(--ink-strong))]">
                  {failedCount}
                </p>
              </div>
            </div>
          </SectionPanel>

          <SectionPanel
            title="Coverage"
            description="This dashboard now layers evaluation and memory visibility over the existing control-plane workflow shape."
          >
            <ul className="space-y-3 text-sm leading-6 text-[rgb(var(--ink-soft))]">
              <li>Requirements attach directly to a project and stay ordered by position.</li>
              <li>Plans stay versioned per project and can be approved in place.</li>
              <li>Tasks, sessions, execution runs, event logs, and curated memory remain linked for drill-down.</li>
            </ul>
          </SectionPanel>
        </div>
      </div>
    </div>
  );
}
