import { cn } from "../lib/cn.js";

export function Separator({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-[var(--border)]", className)} />;
}
