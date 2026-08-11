import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.js";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-[10px] border border-transparent text-sm font-medium tracking-[-0.01em] transition-all duration-200 outline-none disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-[0_16px_28px_rgb(219_89_49_/_0.16)] hover:-translate-y-0.5 hover:brightness-[1.01]",
        outline:
          "border-[color:color-mix(in_srgb,var(--border)_80%,white)] bg-[color:color-mix(in_srgb,var(--background)_92%,white)] text-[var(--foreground)] shadow-[0_8px_24px_rgb(15_23_42_/_0.04)] hover:-translate-y-0.5 hover:bg-[color:color-mix(in_srgb,var(--muted)_88%,white)]",
        secondary:
          "bg-[color:color-mix(in_srgb,var(--secondary)_86%,white)] text-[var(--secondary-foreground)] shadow-[0_8px_24px_rgb(15_23_42_/_0.04)] hover:-translate-y-0.5 hover:opacity-95",
        ghost:
          "border-[color:transparent] bg-transparent hover:border-[color:color-mix(in_srgb,var(--border)_65%,white)] hover:bg-[color:color-mix(in_srgb,var(--background)_86%,white)]",
        destructive:
          "bg-[var(--destructive)]/12 text-[var(--destructive)] hover:bg-[var(--destructive)]/20"
      },
      size: {
        default: "h-11 px-4.5",
        sm: "h-9 px-3.5 text-xs uppercase tracking-[0.12em]",
        lg: "h-12 px-6",
        icon: "size-11",
        "icon-sm": "size-9"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, ...props },
  ref
) {
  return <button ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
});
