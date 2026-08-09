import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { ResourceNotice } from "@/components/resource-notice";
import { SectionPanel } from "@/components/section-panel";
import { getProjectMemory, listProjects } from "@/lib/api/control-plane";

export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const projects = await listProjects();
  const memories = await Promise.all(projects.data.map((project) => getProjectMemory(project.id)));
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Knowledge" title="Memory" description="Curated project knowledge retained by the control plane and available as evidence for later decisions." />
      <ResourceNotice resources={[projects, ...memories]} />
      <SectionPanel title="Project memory" description="Memory is derived from persisted work; it is not browser-local notes.">
        {projects.data.length === 0 ? <EmptyState title="No projects" body="Project memory appears after a project has recorded activity." /> : (
          <div className="divide-y divide-[rgba(var(--line),0.78)]">
            {projects.data.map((project, index) => {
              const memory = memories[index]?.data;
              return <Link key={project.id} href={`/projects/${project.id}`} className="block py-4 hover:bg-white/45"><p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">{project.name}</p><p className="mt-1 line-clamp-2 text-sm leading-6 text-[rgb(var(--ink-soft))]">{memory?.summary || "No curated project memory exists yet."}</p><p className="mt-2 text-xs uppercase tracking-[0.16em] text-[rgb(var(--ink-soft))]">{memory?.entries.length || 0} evidence entries</p></Link>;
            })}
          </div>
        )}
      </SectionPanel>
    </div>
  );
}
