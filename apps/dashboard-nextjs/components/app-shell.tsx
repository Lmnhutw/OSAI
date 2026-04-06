"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/format";

const navItems = [
  {
    href: "/observability",
    label: "Observability",
    description: "Risk, review, QA, retries, and failure filters"
  },
  {
    href: "/projects",
    label: "Projects",
    description: "Registry, plans, memory, tasks, runs, and logs"
  }
];

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
                  A restrained operator surface for Phase 2 evaluation, memory, execution, and decision support.
                </p>
              </div>
            </div>

            <nav className="space-y-2">
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

            <div className="surface-inline rounded-[24px] px-4 py-4">
              <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                Scope
              </p>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-[rgb(var(--ink-soft))]">
                <li>Evaluation and QA visibility</li>
                <li>Memory, decisions, and bug patterns</li>
                <li>Execution history and retry loops</li>
              </ul>
            </div>
          </div>
        </aside>

        <div className="min-w-0">
          <header className="sticky top-0 z-20 border-b border-[rgba(var(--line),0.92)] bg-[rgba(242,244,239,0.86)] backdrop-blur">
            <div className="flex flex-col gap-2 px-5 py-4 md:px-8">
              <p className="text-xs uppercase tracking-[0.28em] text-[rgb(var(--ink-soft))]">
                Phase 2 intelligence
              </p>
              <div className="flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
                <p className="text-lg font-semibold tracking-[-0.03em] text-[rgb(var(--ink-strong))]">
                  Evaluations, memory, runs, and task flow in one surface
                </p>
                <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">
                  Read from the control plane, surface risk, and trigger evaluation actions when operators need them.
                </p>
              </div>
            </div>
          </header>

          <main className="px-5 py-6 md:px-8 md:py-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
