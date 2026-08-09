import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { ResourceNotice } from "@/components/resource-notice";
import { SectionPanel } from "@/components/section-panel";
import { StatusBadge } from "@/components/status-badge";
import { searchResources } from "@/lib/api/control-plane";

export const dynamic = "force-dynamic";

interface SearchPageProps {
  searchParams: Promise<{ q?: string }>;
}

function hrefFor(item: { resource_type: string; resource_id: string }) {
  return item.resource_type === "project" ? `/projects/${item.resource_id}` : item.resource_type === "plan" ? `/plans/${item.resource_id}` : `/tasks/${item.resource_id}`;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const query = (await searchParams).q?.trim() || "";
  const results = query.length >= 2 ? await searchResources(query) : null;
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Global search" title={query ? `Results for “${query}”` : "Search"} description="Find persisted projects, plans, and tasks across the control plane." />
      {results ? <ResourceNotice resources={[results]} /> : null}
      <SectionPanel title="Matches" description="Search uses the control-plane database, not a browser cache.">
        {!results ? <EmptyState title="Enter at least two characters" body="Use the global search bar to find a persisted resource." /> : results.data.items.length === 0 ? <EmptyState title="No matches" body="Try a broader term or create the project/plan first." /> : (
          <div className="divide-y divide-[rgba(var(--line),0.78)]">
            {results.data.items.map((item) => <Link key={`${item.resource_type}:${item.resource_id}`} href={hrefFor(item)} className="flex items-center justify-between gap-4 py-4 hover:bg-white/45"><div className="min-w-0"><p className="truncate text-sm font-semibold text-[rgb(var(--ink-strong))]">{item.title}</p><p className="mt-1 line-clamp-1 text-sm text-[rgb(var(--ink-soft))]">{item.resource_type} · {item.subtitle || "No additional detail"}</p></div>{item.status ? <StatusBadge status={item.status} /> : null}</Link>)}
          </div>
        )}
      </SectionPanel>
    </div>
  );
}
