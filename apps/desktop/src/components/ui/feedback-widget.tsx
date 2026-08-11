"use client"

import { useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { Loader2, MessageSquarePlus, ThumbsDown, ThumbsUp, X } from "lucide-react"

import { cn } from "@/lib/utils.js"
import { Button, Card, CardContent, CardHeader, CardTitle, Textarea } from "@/ui/index.js"

export interface FeedbackWidgetProps {
  title?: string
  placeholder?: string
  onSubmit: (feedback: { rating: "helpful" | "not-helpful"; comment: string }) => Promise<void>
  onClose: () => void
  submitText?: string
  cancelText?: string
  initialRating?: "helpful" | "not-helpful" | null
  initialComment?: string
}

const cardVariants = {
  hidden: { opacity: 0, y: 20, scale: 0.98 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { type: "spring" as const, bounce: 0, duration: 0.34 },
  },
  exit: { opacity: 0, y: 14, scale: 0.98, transition: { duration: 0.16 } },
}

const textAreaVariants = {
  hidden: { opacity: 0, height: 0, marginTop: 0 },
  visible: { opacity: 1, height: "auto", marginTop: "0.85rem", transition: { duration: 0.22 } },
  exit: { opacity: 0, height: 0, marginTop: 0, transition: { duration: 0.18 } },
}

export default function FeedbackWidget({
  title = "Quick feedback",
  placeholder = "What looked right or what needs review?",
  submitText = "Save feedback",
  cancelText = "Close",
  onSubmit,
  onClose,
  initialRating = null,
  initialComment = "",
}: FeedbackWidgetProps) {
  const [rating, setRating] = useState<"helpful" | "not-helpful" | null>(initialRating)
  const [comment, setComment] = useState(initialComment)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const ratingButtonClass =
    "h-7 border px-2.5 text-[0.78rem] font-medium tracking-[-0.01em] transition-all duration-150"

  async function handleSubmit() {
    if (!rating || isSubmitting) return
    setIsSubmitting(true)
    try {
      await onSubmit({ rating, comment })
    } finally {
      setIsSubmitting(false)
    }
  }

  function handleRatingClick(selectedRating: "helpful" | "not-helpful") {
    setRating((current) => (current === selectedRating ? null : selectedRating))
  }

  return (
    <motion.div
      variants={cardVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      className="fixed bottom-4 right-4 z-50 w-[min(24rem,calc(100vw-2rem))]"
      aria-live="polite"
    >
      <Card className="overflow-hidden border-[color:color-mix(in_srgb,var(--border)_82%,white)] shadow-[0_18px_42px_rgb(11_16_32_/_0.1)]">
        <CardHeader className="flex flex-row items-start justify-between gap-3 border-b border-[color:color-mix(in_srgb,var(--border)_82%,white)] px-4 py-3">
          <div className="min-w-0">
            <CardTitle className="text-[0.92rem] font-medium tracking-[-0.02em]">{title}</CardTitle>
            <p className="mt-1 text-[0.78rem] leading-1.5 text-muted-foreground">
              Mark the run quickly without leaving the ledger.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close feedback widget"
          >
            <X className="size-3.5" />
          </Button>
        </CardHeader>
        <CardContent className="px-4 pb-4 pt-3">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className={cn(
                ratingButtonClass,
                rating === "helpful"
                  ? "border-[rgba(82,125,90,0.18)] bg-[rgba(116,170,124,0.16)] text-[rgb(55,92,61)]"
                  : "border-[color:color-mix(in_srgb,var(--border)_82%,white)] bg-[color:color-mix(in_srgb,var(--background)_98%,white)] text-foreground hover:bg-muted"
              )}
              onClick={() => handleRatingClick("helpful")}
              aria-pressed={rating === "helpful"}
            >
              <span className="inline-flex items-center gap-1.5">
                <ThumbsUp className="size-3.5" />
                Looks right
              </span>
            </button>
            <button
              type="button"
              className={cn(
                ratingButtonClass,
                rating === "not-helpful"
                  ? "border-[rgba(166,103,98,0.18)] bg-[rgba(218,142,134,0.16)] text-[rgb(126,72,68)]"
                  : "border-[color:color-mix(in_srgb,var(--border)_82%,white)] bg-[color:color-mix(in_srgb,var(--background)_98%,white)] text-foreground hover:bg-muted"
              )}
              onClick={() => handleRatingClick("not-helpful")}
              aria-pressed={rating === "not-helpful"}
            >
              <span className="inline-flex items-center gap-1.5">
                <ThumbsDown className="size-3.5" />
                Needs review
              </span>
            </button>
          </div>

          <AnimatePresence initial={false}>
            {rating ? (
              <motion.div
                key="textarea"
                variants={textAreaVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                className="overflow-hidden"
              >
                <Textarea
                  placeholder={placeholder}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  className="mt-0 min-h-24 px-3 py-2 text-[0.84rem] shadow-none"
                  rows={3}
                  aria-label="Feedback comment"
                />
              </motion.div>
            ) : null}
          </AnimatePresence>

          <div className="mt-3 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={isSubmitting}
            >
              {cancelText}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!rating || isSubmitting}
              onClick={() => void handleSubmit()}
            >
              {isSubmitting ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquarePlus className="size-3.5" />}
              {submitText}
            </Button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}
