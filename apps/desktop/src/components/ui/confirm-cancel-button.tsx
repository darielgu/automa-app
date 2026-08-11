"use client"

import { useEffect, useState } from "react"
import { AnimatePresence, MotionConfig, motion } from "framer-motion"
import { Check, X } from "lucide-react"

import { Button } from "@/ui/index.js"
import { cn } from "@/lib/utils.js"

type ConfirmCancelButtonProps = {
  onConfirm: () => void | Promise<void>
  className?: string
  disabled?: boolean
  busy?: boolean
}

const smoothSpring = {
  type: "spring" as const,
  bounce: 0,
  duration: 0.28,
}

export default function ConfirmCancelButton({
  onConfirm,
  className,
  disabled = false,
  busy = false,
}: ConfirmCancelButtonProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  useEffect(() => {
    if (busy) {
      setIsExpanded(false)
    }
  }, [busy])

  function handlePrimaryClick() {
    if (disabled || busy) {
      return
    }

    if (!isExpanded) {
      setIsExpanded(true)
      return
    }

    void onConfirm()
  }

  return (
    <MotionConfig transition={smoothSpring}>
      <div className={cn("inline-flex items-center justify-end gap-1", className)}>
        <motion.div whileHover={!disabled && !busy ? { scale: 1.02 } : undefined} whileTap={!disabled && !busy ? { scale: 0.98 } : undefined}>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="h-6 cursor-pointer rounded-none px-2 text-[0.72rem]"
            disabled={disabled || busy}
            onClick={handlePrimaryClick}
            aria-label={busy ? "Cancelling" : isExpanded ? "Confirm cancellation" : "Cancel run"}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={busy ? "busy" : isExpanded ? "confirm" : "cancel"}
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={{ duration: 0.14 }}
                className="inline-flex items-center gap-1.5"
              >
                {busy ? (
                  <>Cancelling</>
                ) : isExpanded ? (
                  <>
                    <Check className="size-3" />
                    Confirm
                  </>
                ) : (
                  "Cancel"
                )}
              </motion.span>
            </AnimatePresence>
          </Button>
        </motion.div>

        <AnimatePresence initial={false}>
          {isExpanded && !busy ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.9, x: -6 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.9, x: -6 }}
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
            >
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-6 cursor-pointer rounded-none"
                onClick={() => setIsExpanded(false)}
                aria-label="Cancel confirmation"
              >
                <X className="size-3" />
              </Button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </MotionConfig>
  )
}
