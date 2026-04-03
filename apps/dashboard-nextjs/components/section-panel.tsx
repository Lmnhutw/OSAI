import { cn } from "@/lib/format";

interface SectionPanelProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

export function SectionPanel({
  title,
  description,
  action,
  className,
  children
}: SectionPanelProps) {
  return (
    <section className={cn("surface-panel rounded-[28px]", className)}>
      <div className="flex flex-col gap-4 border-b border-[rgba(var(--line),0.92)] px-5 py-5 md:flex-row md:items-end md:justify-between md:px-6">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold tracking-[-0.03em] text-[rgb(var(--ink-strong))]">
            {title}
          </h3>
          {description ? (
            <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">{description}</p>
          ) : null}
        </div>
        {action ? <div>{action}</div> : null}
      </div>
      <div className="px-5 py-5 md:px-6 md:py-6">{children}</div>
    </section>
  );
}
