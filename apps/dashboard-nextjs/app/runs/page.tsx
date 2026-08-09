import { PageHeader } from "@/components/page-header";
import { ResourceNotice } from "@/components/resource-notice";
import { RunsTable } from "@/components/runs-table";
import { SectionPanel } from "@/components/section-panel";
import { listRuns } from "@/lib/api/control-plane";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const runs = await listRuns();
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Execution" title="Runs" description="Recent worker attempts across all plans." />
      <ResourceNotice resources={[runs]} />
      <SectionPanel title="Execution runs" description="Open a run to inspect evaluator output and evidence.">
        <RunsTable runs={runs.data} emptyTitle="No runs" emptyBody="Runs appear after an approved task is claimed by the worker." />
      </SectionPanel>
    </div>
  );
}
