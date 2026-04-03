interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

export function PageHeader({ eyebrow, title, description, actions }: PageHeaderProps) {
  return (
    <section className="surface-panel rounded-[32px] px-6 py-6 md:px-8 md:py-8">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl space-y-3">
          {eyebrow ? (
            <p className="text-xs uppercase tracking-[0.3em] text-[rgb(var(--ink-soft))]">
              {eyebrow}
            </p>
          ) : null}
          <div className="space-y-2">
            <h2 className="text-balance text-3xl font-semibold tracking-[-0.04em] text-[rgb(var(--ink-strong))] md:text-4xl">
              {title}
            </h2>
            {description ? (
              <p className="max-w-2xl text-sm leading-7 text-[rgb(var(--ink-soft))] md:text-base">
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
      </div>
    </section>
  );
}
