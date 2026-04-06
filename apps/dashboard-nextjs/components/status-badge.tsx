import { cn, sentenceCase } from "@/lib/format";

const toneMap: Record<string, string> = {
  approved: "bg-emerald-100 text-emerald-800 border-emerald-200",
  completed: "bg-emerald-100 text-emerald-800 border-emerald-200",
  succeeded: "bg-emerald-100 text-emerald-800 border-emerald-200",
  pass: "bg-emerald-100 text-emerald-800 border-emerald-200",
  ready_for_dispatch: "bg-emerald-100 text-emerald-800 border-emerald-200",
  running: "bg-sky-100 text-sky-800 border-sky-200",
  in_progress: "bg-sky-100 text-sky-800 border-sky-200",
  progressed: "bg-sky-100 text-sky-800 border-sky-200",
  pending: "bg-amber-100 text-amber-900 border-amber-200",
  queued: "bg-amber-100 text-amber-900 border-amber-200",
  awaiting_approval: "bg-amber-100 text-amber-900 border-amber-200",
  qa_pending: "bg-amber-100 text-amber-900 border-amber-200",
  review_required: "bg-amber-100 text-amber-900 border-amber-200",
  draft: "bg-slate-100 text-slate-700 border-slate-200",
  open: "bg-slate-100 text-slate-700 border-slate-200",
  not_evaluated: "bg-slate-100 text-slate-700 border-slate-200",
  failed: "bg-rose-100 text-rose-800 border-rose-200",
  rejected: "bg-rose-100 text-rose-800 border-rose-200",
  blocked: "bg-rose-100 text-rose-800 border-rose-200",
  dispatch_blocked: "bg-rose-100 text-rose-800 border-rose-200",
  needs_rework: "bg-rose-100 text-rose-800 border-rose-200",
  needs_context: "bg-orange-100 text-orange-800 border-orange-200",
  awaiting_review: "bg-violet-100 text-violet-800 border-violet-200",
  retrying: "bg-orange-100 text-orange-800 border-orange-200"
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em]",
        toneMap[status] || "bg-slate-100 text-slate-700 border-slate-200"
      )}
    >
      {sentenceCase(status)}
    </span>
  );
}
