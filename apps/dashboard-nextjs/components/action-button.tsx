"use client";

import { useFormStatus } from "react-dom";

import { cn } from "@/lib/format";

interface ActionButtonProps {
  idleLabel: string;
  pendingLabel: string;
  disabled?: boolean;
  className?: string;
}

export function ActionButton({
  idleLabel,
  pendingLabel,
  disabled = false,
  className
}: ActionButtonProps) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className={cn(
        "inline-flex items-center justify-center rounded-full px-4 py-2 text-sm font-medium transition",
        "bg-[rgb(var(--accent))] text-white hover:bg-[rgba(var(--accent),0.92)]",
        "disabled:cursor-not-allowed disabled:bg-[rgba(var(--line-strong),0.9)]",
        className
      )}
    >
      {pending ? pendingLabel : idleLabel}
    </button>
  );
}
