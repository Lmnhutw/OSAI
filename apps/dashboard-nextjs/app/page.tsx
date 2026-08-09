import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { ResourceNotice } from "@/components/resource-notice";
import { SectionPanel } from "@/components/section-panel";
import { StatusBadge } from "@/components/status-badge";
import { getHealth, getModelProfiles, getOperatorQueue, listProjects } from "@/lib/api/control-plane";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [health, models, queue, projects] = await Promise.all([
    getHealth(),
    getModelProfiles(),
    getOperatorQueue(),
    listProjects()
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="OSAI control center"
        title="Overview"
        description="A compact read of the AI runtime, operator backlog, and project portfolio."
      />
      <ResourceNotice resources={[health, models, queue, projects]} />
      <div className="grid gap-4 md:grid-cols-3">
        <SectionPanel title="Operator queue" description="Items requiring a human decision.">
          <p className="text-3xl font-semibold text-[rgb(var(--ink-strong))]">{queue.data.total}</p>
          <Link href="/work-queue" className="mt-3 inline-block text-sm font-medium text-[rgb(var(--accent))]">Open work queue</Link>
        </SectionPanel>
        <SectionPanel title="Model profiles" description="Exactly three logical profiles are configured.">
          <p className="text-3xl font-semibold text-[rgb(var(--ink-strong))]">{models.data.filter((model) => model.configured).length}/3</p>
          <Link href="/ai-runtime" className="mt-3 inline-block text-sm font-medium text-[rgb(var(--accent))]">Inspect AI runtime</Link>
        </SectionPanel>
        <SectionPanel title="Projects" description="Projects visible to the control plane.">
          <p className="text-3xl font-semibold text-[rgb(var(--ink-strong))]">{projects.data.length}</p>
          <Link href="/projects" className="mt-3 inline-block text-sm font-medium text-[rgb(var(--accent))]">Open projects</Link>
        </SectionPanel>
      </div>
      <SectionPanel title="Control-plane health" description="Readiness is verified against PostgreSQL.">
        <StatusBadge status={health.data?.status || health.state} />
      </SectionPanel>
    </div>
  );
}
