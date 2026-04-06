import { cn, sentenceCase } from "@/lib/format";

const toneMap: Record<string, string> = {
  high: "border-rose-300 bg-rose-100 text-rose-900",
  medium: "border-amber-300 bg-amber-100 text-amber-900",
  low: "border-emerald-300 bg-emerald-100 text-emerald-900",
  unknown: "border-slate-300 bg-slate-100 text-slate-700"
};

export function RiskBadge({ risk }: { risk?: string | null }) {
  const value = risk || "unknown";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em]",
        toneMap[value] || toneMap.unknown
      )}
    >
      Risk {sentenceCase(value)}
    </span>
  );
}
