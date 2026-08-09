import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { ResourceNotice } from "@/components/resource-notice";
import { SectionPanel } from "@/components/section-panel";
import { StatusBadge } from "@/components/status-badge";
import { listPlans } from "@/lib/api/control-plane";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function PlansPage() {
  const plans = await listPlans();
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Orchestration" title="Plans" description="Versioned AI-generated plans and their approval state." />
      <ResourceNotice resources={[plans]} />
      <SectionPanel title="Recent plans" description="Sorted by last update; open a plan for evidence and operator decisions.">
        {plans.data.length === 0 ? <EmptyState title="No plans" body="Generate a plan from a project to begin review." /> : (
          <div className="divide-y divide-[rgba(var(--line),0.78)]">
            {plans.data.map((plan) => <Link key={plan.id} href={`/plans/${plan.id}`} className="flex items-center justify-between gap-4 py-4 hover:bg-white/45">
              <div className="min-w-0"><p className="truncate text-sm font-semibold text-[rgb(var(--ink-strong))]">{plan.title}</p><p className="mt-1 text-sm text-[rgb(var(--ink-soft))]">v{plan.version} · {formatDateTime(plan.updated_at)}</p></div><StatusBadge status={plan.status} />
            </Link>)}
          </div>
        )}
      </SectionPanel>
    </div>
  );
}
