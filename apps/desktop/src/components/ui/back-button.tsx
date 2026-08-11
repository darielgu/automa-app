"use client"

import { ArrowLeft } from "lucide-react"

import { Button } from "@/components/ui/button.js"
import { cn } from "@/lib/utils.js"

type BackButtonProps = {
  onClick?: () => void
  label?: string
  className?: string
}

export default function BackButton({
  onClick,
  label = "Back",
  className,
}: BackButtonProps) {
  return (
    <Button
      type="button"
      onClick={onClick}
      className={cn("group relative overflow-hidden rounded-none pl-10 pr-3", className)}
      aria-label={label}
    >
      <span className="translate-x-2 transition-opacity duration-500 group-hover:opacity-0">
        {label}
      </span>
      <i className="absolute inset-y-0 left-0 z-10 grid w-8 place-items-center bg-primary-foreground/15 transition-all duration-500 group-hover:w-full">
        <ArrowLeft
          className="opacity-60"
          size={16}
          strokeWidth={2}
          aria-hidden="true"
        />
      </i>
    </Button>
  )
}
