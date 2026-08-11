import { cn } from "../lib/cn.js";

/**
 * Determinate progress bar.
 *
 * Animates `transform`, not `width`. design.md is explicit that only transform
 * and opacity may animate: a width transition relayouts the bar on every frame,
 * while a scaleX runs on the compositor.
 */
export function Progress({ value, className }: { value: number; className?: string }) {
  const fraction = Math.max(0, Math.min(100, value)) / 100;
  return (
    <div
      className={cn("h-2 w-full overflow-hidden rounded-none bg-[var(--muted)]", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
    >
      <div
        className="h-full w-full origin-left bg-[var(--primary)] transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
        style={{ transform: `scaleX(${fraction})` }}
      />
    </div>
  );
}
