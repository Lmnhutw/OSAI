import { PageHeader } from "@/components/page-header";
import { ResourceNotice } from "@/components/resource-notice";
import { SectionPanel } from "@/components/section-panel";
import { StatusBadge } from "@/components/status-badge";
import { getHealth, getModelProfiles, listAgentRuns } from "@/lib/api/control-plane";

export const dynamic = "force-dynamic";

export default async function SystemHealthPage() {
  const [health, models, agentRuns] = await Promise.all([getHealth(), getModelProfiles(), listAgentRuns()]);
  const failedRuns = agentRuns.data.filter((run) => run.status === "failed" || run.status === "blocked");
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Operations" title="System health" description="Readiness of the control plane, model configuration, and recent agent failures." />
      <ResourceNotice resources={[health, models, agentRuns]} />
      <div className="grid gap-4 md:grid-cols-3">
        <SectionPanel title="Control plane" description="Database readiness probe."><StatusBadge status={health.data?.status || health.state} /></SectionPanel>
        <SectionPanel title="Model profiles" description="Configured logical profiles."><p className="text-3xl font-semibold text-[rgb(var(--ink-strong))]">{models.data.filter((model) => model.configured).length}/3</p></SectionPanel>
        <SectionPanel title="Agent failures" description="Recent durable run records."><p className="text-3xl font-semibold text-[rgb(var(--ink-strong))]">{failedRuns.length}</p></SectionPanel>
      </div>
    </div>
  );
}
