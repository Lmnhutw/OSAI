interface KeyValueGridProps {
  items: Array<{
    label: string;
    value: React.ReactNode;
  }>;
}

export function KeyValueGrid({ items }: KeyValueGridProps) {
  return (
    <div className="data-grid">
      {items.map((item) => (
        <div key={item.label} className="surface-inline rounded-2xl p-4">
          <p className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
            {item.label}
          </p>
          <div className="mt-3 text-sm leading-6 text-[rgb(var(--ink-strong))]">{item.value}</div>
        </div>
      ))}
    </div>
  );
}
