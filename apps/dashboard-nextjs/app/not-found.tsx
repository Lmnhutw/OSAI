import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { SectionPanel } from "@/components/section-panel";

export default function NotFound() {
  return (
    <SectionPanel
      title="Record not found"
      description="The requested entity is not available in the current control-plane dataset."
    >
      <EmptyState
        title="Nothing matched this route"
        body="Check the entity identifier or return to the project registry."
        action={
          <Link
            href="/projects"
            className="inline-flex rounded-full border border-[rgb(var(--line))] px-4 py-2 text-sm font-medium text-[rgb(var(--ink-strong))] transition hover:border-[rgb(var(--line-strong))] hover:bg-white"
          >
            Back to projects
          </Link>
        }
      />
    </SectionPanel>
  );
}
