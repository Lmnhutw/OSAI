import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { KeyValueGrid } from "@/components/key-value-grid";
import { PageHeader } from "@/components/page-header";
import { ResourceNotice } from "@/components/resource-notice";
import { RunsTable } from "@/components/runs-table";
import { SectionPanel } from "@/components/section-panel";
import { StatusBadge } from "@/components/status-badge";
import { TasksByStatus } from "@/components/tasks-by-status";
import {
  emptyResource,
  getProject,
  listPlanRuns,
  listPlanTasks,
  listProjectPlans,
  listProjectRequirements
} from "@/lib/api/control-plane";
import { formatDateTime, truncateId } from "@/lib/format";

export const dynamic = "force-dynamic";

interface ProjectDetailPageProps {
  params: {
    id: string;
  };
}

export default async function ProjectDetailPage({ params }: ProjectDetailPageProps) {
  const [project, requirements, plans] = await Promise.all([
    getProject(params.id),
    listProjectRequirements(params.id),
    listProjectPlans(params.id)
  ]);

  if (project.state === "not_found") {
    notFound();
  }

  const sortedPlans = [...plans.data].sort((left, right) => right.version - left.version);
  const activePlan = sortedPlans[0] ?? null;

  const [tasks, runs] = activePlan
    ? await Promise.all([listPlanTasks(activePlan.id), listPlanRuns(activePlan.id)])
    : [
        emptyResource([], `/plans/${params.id}/tasks`),
        emptyResource([], `/plans/${params.id}/runs`)
      ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Project overview"
        title={project.data?.name || `Project ${truncateId(params.id, 10)}`}
        description={
          project.data?.description ||
          "Track requirements, versioned plans, grouped task status, and recent execution activity."
        }
        actions={project.data ? <StatusBadge status={project.data.status} /> : null}
      />

      <ResourceNotice resources={[project, requirements, plans, tasks, runs]} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <SectionPanel
            title="Project details"
            description="Core identifiers and timestamps for the current project scope."
          >
            <KeyValueGrid
              items={[
                {
                  label: "Project ID",
                  value: (
                    <span className="font-mono text-sm text-[rgb(var(--ink-strong))]">
                      {project.data?.id || params.id}
                    </span>
                  )
                },
                {
                  label: "Created",
                  value: formatDateTime(project.data?.created_at)
                },
                {
                  label: "Updated",
                  value: formatDateTime(project.data?.updated_at)
                },
                {
                  label: "Latest plan",
                  value: activePlan ? `v${activePlan.version}` : "No plan yet"
                }
              ]}
            />
          </SectionPanel>

          <SectionPanel
            title="Requirements"
            description="Ordered project requirements supplied to the planning agent."
          >
            {requirements.data.length === 0 ? (
              <EmptyState
                title="No requirements returned"
                body="Requirement rows will appear here once the control plane exposes them for this project."
              />
            ) : (
              <ol className="space-y-3">
                {requirements.data
                  .slice()
                  .sort((left, right) => left.position - right.position)
                  .map((requirement) => (
                    <li key={requirement.id} className="surface-inline rounded-2xl px-4 py-4">
                      <div className="flex items-start gap-4">
                        <span className="mt-0.5 inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-[rgb(var(--accent-soft))] px-2 text-xs font-semibold text-[rgb(var(--accent))]">
                          {requirement.position}
                        </span>
                        <div className="space-y-1">
                          <p className="text-sm leading-6 text-[rgb(var(--ink-strong))]">
                            {requirement.requirement_text}
                          </p>
                          <p className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                            Captured {formatDateTime(requirement.created_at)}
                          </p>
                        </div>
                      </div>
                    </li>
                  ))}
              </ol>
            )}
          </SectionPanel>

          <SectionPanel
            title="Plan versions"
            description="Versioned orchestration proposals attached to this project."
          >
            {sortedPlans.length === 0 ? (
              <EmptyState
                title="No plans returned"
                body="The planning route can generate plans, and detail views will appear here as soon as the API exposes them."
              />
            ) : (
              <div className="space-y-3">
                {sortedPlans.map((plan) => (
                  <Link
                    key={plan.id}
                    href={`/plans/${plan.id}`}
                    className="surface-inline flex items-center justify-between rounded-2xl px-4 py-4 transition hover:border-[rgb(var(--line-strong))] hover:bg-white"
                  >
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">
                        v{plan.version} · {plan.title}
                      </p>
                      <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">
                        {plan.summary || "No plan summary recorded yet."}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge status={plan.status} />
                      <span className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                        {formatDateTime(plan.updated_at)}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </SectionPanel>
        </div>

        <div className="space-y-6">
          <SectionPanel
            title="Current plan snapshot"
            description="The latest plan is used as the working surface for grouped task state and run activity."
          >
            {activePlan ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">
                    {activePlan.title}
                  </p>
                  <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">
                    {activePlan.summary || "No summary recorded yet."}
                  </p>
                </div>
                <div className="data-grid">
                  <div className="surface-inline rounded-2xl p-4">
                    <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                      Plan version
                    </p>
                    <p className="mt-2 text-2xl font-semibold text-[rgb(var(--ink-strong))]">
                      v{activePlan.version}
                    </p>
                  </div>
                  <div className="surface-inline rounded-2xl p-4">
                    <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                      Tasks
                    </p>
                    <p className="mt-2 text-2xl font-semibold text-[rgb(var(--ink-strong))]">
                      {tasks.data.length}
                    </p>
                  </div>
                  <div className="surface-inline rounded-2xl p-4">
                    <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                      Runs
                    </p>
                    <p className="mt-2 text-2xl font-semibold text-[rgb(var(--ink-strong))]">
                      {runs.data.length}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={activePlan.status} />
                  <Link
                    href={`/plans/${activePlan.id}`}
                    className="text-sm font-medium text-[rgb(var(--accent))] transition hover:text-[rgb(var(--ink-strong))]"
                  >
                    Open plan detail
                  </Link>
                </div>
              </div>
            ) : (
              <EmptyState
                title="No current plan"
                body="Generate or expose a plan first to populate grouped tasks and execution runs."
              />
            )}
          </SectionPanel>

          <SectionPanel
            title="Recent execution runs"
            description="Newest run attempts for the latest available plan."
          >
            <RunsTable
              runs={runs.data}
              emptyTitle="No runs returned"
              emptyBody="Execution attempts will appear here once sessions and runs are exposed through the API layer."
            />
          </SectionPanel>
        </div>
      </div>

      <SectionPanel
        title="Tasks grouped by status"
        description={
          activePlan
            ? `Grouped task visibility for plan v${activePlan.version}.`
            : "No plan is available yet for grouped task visibility."
        }
      >
        {activePlan ? (
          <TasksByStatus tasks={tasks.data} />
        ) : (
          <EmptyState
            title="No active plan"
            body="As soon as a plan exists, the dashboard will group its tasks by current execution status."
          />
        )}
      </SectionPanel>
    </div>
  );
}
