interface CollapsibleLogProps {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export function CollapsibleLog({
  title,
  subtitle,
  defaultOpen = false,
  children
}: CollapsibleLogProps) {
  return (
    <details open={defaultOpen} className="surface-inline rounded-[24px]">
      <summary className="flex cursor-pointer items-start justify-between gap-4 px-4 py-4">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">{title}</p>
          {subtitle ? (
            <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">{subtitle}</p>
          ) : null}
        </div>
        <span className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
          Toggle
        </span>
      </summary>
      <div className="border-t border-[rgba(var(--line),0.88)] px-4 py-4">{children}</div>
    </details>
  );
}
