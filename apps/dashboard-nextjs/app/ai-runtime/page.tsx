import { PageHeader } from "@/components/page-header";
import { ResourceNotice } from "@/components/resource-notice";
import { SectionPanel } from "@/components/section-panel";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime, truncateId } from "@/lib/format";
import { getModelProfiles, listAgentRuns } from "@/lib/api/control-plane";

export const dynamic = "force-dynamic";

export default async function AiRuntimePage() {
  const [profiles, agentRuns] = await Promise.all([getModelProfiles(), listAgentRuns()]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Runtime control"
        title="AI runtime"
        description="Monitor the three configured model profiles and the durable record of every agent invocation. Credentials are intentionally never shown here."
      />

      <ResourceNotice resources={[profiles, agentRuns]} />

      <SectionPanel
        title="Model profiles"
        description="Reasoning drives planning, execution drives bounded work, and review validates output. Configure keys through the control-plane environment."
      >
        <div className="divide-y divide-[rgba(var(--line),0.82)]">
          {profiles.data.map((profile) => (
            <div key={profile.profile} className="grid gap-3 py-4 sm:grid-cols-[150px_minmax(0,1fr)_auto] sm:items-center">
              <div>
                <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">{profile.profile}</p>
                <p className="mt-1 text-xs uppercase tracking-[0.16em] text-[rgb(var(--ink-soft))]">logical profile</p>
              </div>
              <div className="min-w-0 text-sm text-[rgb(var(--ink-soft))]">
                {profile.configured ? (
                  <p className="truncate">{profile.provider} · {profile.model}</p>
                ) : (
                  <p>{profile.error || "Configuration is missing."}</p>
                )}
              </div>
              <StatusBadge status={profile.configured ? "succeeded" : "blocked"} />
            </div>
          ))}
          {profiles.data.length === 0 ? (
            <p className="py-4 text-sm text-[rgb(var(--ink-soft))]">The control plane did not return model profile status.</p>
          ) : null}
        </div>
      </SectionPanel>

      <SectionPanel
        title="Recent agent runs"
        description="Persisted agent activity, including failures, is available here after the migration is applied."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-[rgba(var(--line),0.9)] text-xs uppercase tracking-[0.16em] text-[rgb(var(--ink-soft))]">
              <tr>
                <th className="px-2 py-3 font-medium">Agent</th>
                <th className="px-2 py-3 font-medium">Profile</th>
                <th className="px-2 py-3 font-medium">Status</th>
                <th className="px-2 py-3 font-medium">Started</th>
                <th className="px-2 py-3 font-medium">Correlation</th>
                <th className="px-2 py-3 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[rgba(var(--line),0.72)] text-[rgb(var(--ink-soft))]">
              {agentRuns.data.map((run) => (
                <tr key={run.id}>
                  <td className="px-2 py-4 font-medium text-[rgb(var(--ink-strong))]">{run.agent_key}</td>
                  <td className="px-2 py-4">{run.model_profile}</td>
                  <td className="px-2 py-4"><StatusBadge status={run.status} /></td>
                  <td className="px-2 py-4">{formatDateTime(run.started_at || run.created_at)}</td>
                  <td className="px-2 py-4 font-mono text-xs">{truncateId(run.correlation_id, 12)}</td>
                  <td className="max-w-[280px] truncate px-2 py-4">{run.error_message || "Completed without an error."}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {agentRuns.data.length === 0 ? (
            <p className="py-5 text-sm text-[rgb(var(--ink-soft))]">No agent runs have been recorded yet.</p>
          ) : null}
        </div>
      </SectionPanel>
    </div>
  );
}
