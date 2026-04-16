import { cn, sentenceCase } from "@/lib/format";

const toneMap: Record<string, string> = {
  auto_execute: "border-emerald-300 bg-emerald-100 text-emerald-900",
  review_required: "border-amber-300 bg-amber-100 text-amber-900",
  approval_required: "border-orange-300 bg-orange-100 text-orange-900",
  blocked: "border-rose-300 bg-rose-100 text-rose-900",
  manual: "border-slate-300 bg-slate-100 text-slate-700"
};

export function AutonomyModeBadge({
  mode
}: {
  mode: "auto_execute" | "review_required" | "approval_required" | "blocked" | "manual";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em]",
        toneMap[mode] || toneMap.manual
      )}
    >
      {sentenceCase(mode)}
    </span>
  );
}
