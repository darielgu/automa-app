import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.js";

const badgeVariants = cva(
  "inline-flex items-center rounded-[2px] border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.12em]",
  {
    variants: {
      variant: {
        default: "border-[var(--primary)]/30 bg-[var(--primary)]/10 text-[var(--primary)]",
        secondary: "border-[var(--border)] bg-[var(--muted)] text-[var(--muted-foreground)]",
        outline: "border-[var(--border)] text-[var(--muted-foreground)]",
        destructive: "border-[var(--destructive)]/30 bg-[var(--destructive)]/10 text-[var(--destructive)]"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}
