"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/format";
import { RecentItems } from "@/components/recent-items";

const navItems = [
  {
    href: "/",
    label: "Overview",
    description: "Current system posture, model readiness, and operator workload"
  },
  {
    href: "/work-queue",
    label: "Work queue",
    description: "Pending plan approvals and tasks that require operator attention"
  },
  {
    href: "/projects",
    label: "Projects",
    description: "Registry, plans, memory, tasks, contracts, and logs"
  },
  {
    href: "/plans",
    label: "Plans",
    description: "Versioned AI proposals and approval status"
  },
  {
    href: "/runs",
    label: "Runs",
    description: "Execution attempts and evaluation handoffs"
  },
  {
    href: "/memory",
    label: "Memory",
    description: "Curated project knowledge and evidence"
  },
  {
    href: "/observability",
    label: "Policies",
    description: "Autonomy policy, confidence, overrides, and escalations"
  },
  {
    href: "/system-health",
    label: "System health",
    description: "Control-plane readiness and model configuration"
  },
  {
    href: "/ai-runtime",
    label: "AI runtime",
    description: "Three model profiles, agent activity, and audit readiness"
  }
];

function breadcrumbLabel(segment: string) {
  if (segment === "ai-runtime") return "AI runtime";
  if (segment === "work-queue") return "Work queue";
  if (segment === "system-health") return "System health";
  return segment.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen">
      <div className="mx-auto grid min-h-screen max-w-[1600px] lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="border-b border-[rgba(var(--line),0.92)] px-5 py-6 lg:border-b-0 lg:border-r lg:px-6 lg:py-8">
          <div className="space-y-8">
            <div className="space-y-3">
              <p className="text-xs uppercase tracking-[0.34em] text-[rgb(var(--ink-soft))]">
                OSAI
              </p>
              <div className="space-y-2">
                <h1 className="text-2xl font-semibold tracking-[-0.03em] text-[rgb(var(--ink-strong))]">
                  Control intelligence
                </h1>
                <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">
                  A restrained operator surface for Phase 4 selective autonomy, operator trust, and controlled execution.
                </p>
              </div>
            </div>

            <details className="group lg:hidden">
              <summary className="cursor-pointer rounded-xl border border-[rgb(var(--line))] bg-white/75 px-4 py-3 text-sm font-semibold text-[rgb(var(--ink-strong))] focus-visible:ring-2 focus-visible:ring-[rgb(var(--focus))]">
                Open navigation
              </summary>
              <nav aria-label="Mobile navigation" className="mt-3 space-y-2">
                {navItems.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="block rounded-xl px-3 py-2 text-sm text-[rgb(var(--ink-strong))] hover:bg-white/70"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </details>

            <nav aria-label="Primary navigation" className="hidden space-y-2 lg:block">
              {navItems.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "block rounded-[24px] border px-4 py-4 transition",
                      active
                        ? "border-[rgba(var(--accent),0.28)] bg-[rgba(var(--accent),0.08)]"
                        : "border-transparent hover:border-[rgba(var(--line),0.92)] hover:bg-white/60"
                    )}
                  >
                    <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">{item.label}</p>
                    <p className="mt-1 text-sm leading-6 text-[rgb(var(--ink-soft))]">
                      {item.description}
                    </p>
                  </Link>
                );
              })}
            </nav>

            <RecentItems />

            <div className="surface-inline rounded-[24px] px-4 py-4">
              <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                Scope
              </p>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-[rgb(var(--ink-soft))]">
                <li>Selective autonomy decisions and confidence</li>
                <li>Memory, policy evidence, and operator overrides</li>
                <li>Execution history, contracts, and escalation loops</li>
              </ul>
            </div>
          </div>
        </aside>

        <div className="min-w-0">
          <header className="sticky top-0 z-20 border-b border-[rgba(var(--line),0.92)] bg-[rgba(242,244,239,0.86)] backdrop-blur">
            <div className="flex flex-col gap-3 px-5 py-4 md:px-8">
              <nav aria-label="Breadcrumb" className="overflow-x-auto">
                <ol className="flex min-w-max items-center gap-2 text-xs text-[rgb(var(--ink-soft))]">
                  <li><Link href="/" className="hover:text-[rgb(var(--ink-strong))]">Overview</Link></li>
                  {pathname.split("/").filter(Boolean).map((segment, index, segments) => {
                    const href = `/${segments.slice(0, index + 1).join("/")}`;
                    const current = index === segments.length - 1;
                    return (
                      <li key={`${href}-${segment}`} className="flex items-center gap-2">
                        <span aria-hidden="true">/</span>
                        {current ? (
                          <span aria-current="page">{breadcrumbLabel(segment)}</span>
                        ) : (
                          <Link href={href} className="hover:text-[rgb(var(--ink-strong))]">{breadcrumbLabel(segment)}</Link>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </nav>
              <p className="text-xs uppercase tracking-[0.28em] text-[rgb(var(--ink-soft))]">
                Phase 4 control surface
              </p>
              <div className="flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
                <p className="text-lg font-semibold tracking-[-0.03em] text-[rgb(var(--ink-strong))]">
                  Selective autonomy, contracts, evidence, and execution flow in one surface
                </p>
                <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">
                  Read from the control plane, surface risk and confidence, and let operators inspect or influence automation safely.
                </p>
              </div>
              <form action="/search" className="flex max-w-xl items-center gap-2">
                <label htmlFor="global-search" className="sr-only">Search OSAI</label>
                <input
                  id="global-search"
                  name="q"
                  minLength={2}
                  placeholder="Search projects, plans, and tasks"
                  className="w-full rounded-xl border border-[rgb(var(--line))] bg-white/80 px-3 py-2 text-sm text-[rgb(var(--ink-strong))] outline-none transition focus-visible:ring-2 focus-visible:ring-[rgb(var(--focus))]"
                />
                <button type="submit" className="rounded-xl bg-[rgb(var(--accent))] px-3 py-2 text-sm font-medium text-white">Search</button>
              </form>
            </div>
          </header>

          <main className="px-5 py-6 md:px-8 md:py-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
