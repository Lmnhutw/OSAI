interface EmptyStateProps {
  title: string;
  body: string;
  action?: React.ReactNode;
}

export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <div className="surface-inline rounded-[24px] px-5 py-6">
      <div className="max-w-xl space-y-2">
        <p className="text-base font-semibold text-[rgb(var(--ink-strong))]">{title}</p>
        <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">{body}</p>
      </div>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
