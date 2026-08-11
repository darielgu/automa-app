import * as React from "react";
import { cn } from "../lib/cn.js";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "h-12 w-full rounded-[10px] border border-[color:color-mix(in_srgb,var(--border)_72%,white)] bg-[color:color-mix(in_srgb,var(--background)_96%,white)] px-4 text-sm shadow-[inset_0_1px_0_rgb(255_255_255_/_0.48)] outline-none transition-all duration-200 placeholder:text-[var(--muted-foreground)] focus:border-[var(--primary)]/40 focus:bg-white focus:shadow-[0_0_0_4px_color-mix(in_srgb,var(--primary)_12%,transparent)]",
          className
        )}
        {...props}
      />
    );
  }
);
