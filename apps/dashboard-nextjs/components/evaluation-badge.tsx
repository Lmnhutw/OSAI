import { cn, sentenceCase } from "@/lib/format";

const toneMap: Record<string, string> = {
  pass: "border-emerald-200 bg-emerald-50 text-emerald-800",
  ready_for_dispatch: "border-emerald-200 bg-emerald-50 text-emerald-800",
  review_required: "border-amber-200 bg-amber-50 text-amber-800",
  qa_pending: "border-amber-200 bg-amber-50 text-amber-800",
  awaiting_review: "border-violet-200 bg-violet-50 text-violet-800",
  needs_context: "border-orange-200 bg-orange-50 text-orange-800",
  dispatch_blocked: "border-rose-200 bg-rose-50 text-rose-800",
  blocked: "border-rose-200 bg-rose-50 text-rose-800",
  needs_rework: "border-rose-200 bg-rose-50 text-rose-800",
  not_evaluated: "border-slate-200 bg-slate-50 text-slate-700",
  progressed: "border-sky-200 bg-sky-50 text-sky-800"
};

interface EvaluationBadgeProps {
  label: string;
  status?: string | null;
}

export function EvaluationBadge({ label, status }: EvaluationBadgeProps) {
  const value = status || "not_evaluated";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium",
        toneMap[value] || toneMap.not_evaluated
      )}
    >
      <span className="uppercase tracking-[0.18em] opacity-70">{label}</span>
      <span className="font-semibold">{sentenceCase(value)}</span>
    </span>
  );
}
