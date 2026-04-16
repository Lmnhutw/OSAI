import { cn, formatConfidence } from "@/lib/format";

const toneMap: Record<string, string> = {
  high: "border-emerald-300 bg-emerald-100 text-emerald-900",
  medium: "border-amber-300 bg-amber-100 text-amber-900",
  low: "border-rose-300 bg-rose-100 text-rose-900",
  unknown: "border-slate-300 bg-slate-100 text-slate-700"
};

interface ConfidenceBadgeProps {
  score?: number | null;
  band?: "high" | "medium" | "low";
}

export function ConfidenceBadge({ score, band }: ConfidenceBadgeProps) {
  const resolvedBand =
    band || (score == null ? "unknown" : score >= 0.76 ? "high" : score >= 0.5 ? "medium" : "low");

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em]",
        toneMap[resolvedBand] || toneMap.unknown
      )}
    >
      Confidence {formatConfidence(score)}
    </span>
  );
}
