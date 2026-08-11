import * as React from "react";
import { cn } from "../lib/cn.js";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "min-h-28 w-full rounded-[2px] border border-[color:color-mix(in_srgb,var(--border)_70%,white)] bg-[color:color-mix(in_srgb,var(--background)_84%,white)] px-4 py-3 text-sm shadow-[inset_0_1px_0_rgb(255_255_255_/_0.45)] outline-none transition-all duration-200 placeholder:text-[var(--muted-foreground)] focus:border-[var(--primary)]/40 focus:bg-white focus:shadow-[0_0_0_4px_color-mix(in_srgb,var(--primary)_14%,transparent)]",
          className
        )}
        {...props}
      />
    );
  }
);
