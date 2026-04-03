import type { ApiResource } from "@/lib/api/types";

function describeResource(resource: ApiResource<unknown>) {
  switch (resource.state) {
    case "offline":
      return `The control plane is unreachable for ${resource.path}. Check CONTROL_PLANE_API_BASE_URL and the Python service.`;
    case "missing":
      return `The read endpoint ${resource.path} is not available yet. The page is showing the rest of the available data.`;
    case "error":
      return `Request ${resource.path} returned ${resource.status || "an error"}${resource.message ? `: ${resource.message}` : "."}`;
    default:
      return null;
  }
}

export function ResourceNotice({ resources }: { resources: Array<ApiResource<unknown>> }) {
  const messages = Array.from(
    new Set(resources.map(describeResource).filter((message): message is string => Boolean(message)))
  );

  if (messages.length === 0) {
    return null;
  }

  return (
    <section className="rounded-[24px] border border-amber-200 bg-[rgb(var(--warning-soft))] px-5 py-4 text-amber-950">
      <p className="text-xs uppercase tracking-[0.22em] text-amber-900/80">Connection notes</p>
      <ul className="mt-3 space-y-2 text-sm leading-6">
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    </section>
  );
}
