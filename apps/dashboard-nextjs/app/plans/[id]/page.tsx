import Link from "next/link";
import { notFound } from "next/navigation";

import { PlanApprovalDecisionForm } from "@/components/approval-forms";
import { PlanTaskGenerationForm } from "@/components/generation-forms";
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
  getPlan,
  getProject,
  listPlanApprovals,
  listPlanRuns,
  listPlanTasks
} from "@/lib/api/control-plane";
import { formatDateTime, sentenceCase, truncateId } from "@/lib/format";

export const dynamic = "force-dynamic";

interface PlanDetailPageProps {
  params: Promise<{
    id: string;
  }>;
}

export default async function PlanDetailPage({ params }: PlanDetailPageProps) {
  const { id } = await params;
  const plan = await getPlan(id);

  if (plan.state === "not_found") {
    notFound();
  }

  const [project, approvals, tasks, runs] = plan.data
    ? await Promise.all([
        getProject(plan.data.project_id),
        listPlanApprovals(plan.data.id),
        listPlanTasks(plan.data.id),
        listPlanRuns(plan.data.id)
      ])
    : [
        emptyResource(null, `/projects/${id}`),
        emptyResource([], `/plans/${id}/approvals`),
        emptyResource([], `/plans/${id}/tasks`),
        emptyResource([], `/plans/${id}/runs`)
      ];

  const sortedApprovals = [...approvals.data].sort((left, right) =>
    right.requested_at.localeCompare(left.requested_at)
  );
  const pendingApproval = sortedApprovals.find((approval) => approval.status === "pending");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Plan detail"
        title={plan.data?.title || `Plan ${truncateId(id, 10)}`}
        description={
          plan.data?.summary ||
          "Review approval status, grouped tasks, and execution activity for this plan version."
        }
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {plan.data ? <StatusBadge status={plan.data.status} /> : null}
            {plan.data && pendingApproval ? (
              <PlanApprovalDecisionForm
                approvalId={pendingApproval.id}
                planId={plan.data.id}
                projectId={plan.data.project_id}
                expectedPlanUpdatedAt={plan.data.updated_at}
              />
            ) : null}
            {plan.data && plan.data.status === "approved" && tasks.data.length === 0 ? (
              <PlanTaskGenerationForm planId={plan.data.id} projectId={plan.data.project_id} />
            ) : null}
          </div>
        }
      />

      <ResourceNotice resources={[plan, project, approvals, tasks, runs]} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <SectionPanel
            title="Plan overview"
            description="Summary metadata and ownership for the selected plan."
          >
            <KeyValueGrid
              items={[
                {
                  label: "Plan ID",
                  value: (
                    <span className="font-mono text-sm text-[rgb(var(--ink-strong))]">
                      {plan.data?.id || id}
                    </span>
                  )
                },
                {
                  label: "Version",
                  value: plan.data ? `v${plan.data.version}` : "Unknown"
                },
                {
                  label: "Project",
                  value: project.data ? (
                    <Link
                      href={`/projects/${project.data.id}`}
                      className="font-medium text-[rgb(var(--accent))] transition hover:text-[rgb(var(--ink-strong))]"
                    >
                      {project.data.name}
                    </Link>
                  ) : (
                    "Unavailable"
                  )
                },
                {
                  label: "Updated",
                  value: formatDateTime(plan.data?.updated_at)
                }
              ]}
            />
          </SectionPanel>

          <SectionPanel
            title="Tasks grouped by status"
            description="Operational task grouping for this plan."
          >
            <TasksByStatus tasks={tasks.data} />
          </SectionPanel>

          <SectionPanel
            title="Recent execution runs"
            description="Run attempts linked to this plan through task sessions."
          >
            <RunsTable
              runs={runs.data}
              emptyTitle="No execution runs returned"
              emptyBody="Runs will populate here when the API/DB layer exposes plan-level execution history."
            />
          </SectionPanel>
        </div>

        <div className="space-y-6">
          <SectionPanel
            title="Approval history"
            description="Operator decisions are persisted with an actor, concurrency check, and idempotency key."
          >
            {sortedApprovals.length === 0 ? (
              <EmptyState
                title="No approval records returned"
                body="Approvals will appear here after plan review actions are recorded."
              />
            ) : (
              <div className="space-y-3">
                {sortedApprovals.map((approval) => (
                  <div key={approval.id} className="surface-inline rounded-2xl px-4 py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">
                          {approval.requested_by}
                        </p>
                        <p className="text-sm text-[rgb(var(--ink-soft))]">
                          {approval.decision_note || "No decision note was supplied."}
                        </p>
                      </div>
                      <StatusBadge status={approval.status} />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-4 text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                      <span>Requested {formatDateTime(approval.requested_at)}</span>
                      <span>Approver {approval.approver || "unassigned"}</span>
                      <span>Decided {formatDateTime(approval.decided_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionPanel>

          <SectionPanel
            title="Execution coverage"
            description="Quick readout of task and run totals attached to this plan."
          >
            <div className="data-grid">
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
              <div className="surface-inline rounded-2xl p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                  Status
                </p>
                <p className="mt-2 text-base font-semibold text-[rgb(var(--ink-strong))]">
                  {sentenceCase(plan.data?.status || "unknown")}
                </p>
              </div>
            </div>
          </SectionPanel>
        </div>
      </div>
    </div>
  );
}
