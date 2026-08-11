"use client"

import { Fragment, type ReactNode } from "react"
import { CalendarDays, ChevronDown, ThumbsDown, ThumbsUp } from "lucide-react"
import { motion } from "framer-motion"

import { Button } from "@/components/ui/button.js"
import { Skeleton } from "@/components/ui/skeleton.js"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.js"
import { Progress } from "@/ui/components/progress.js"
import { cn } from "@/lib/utils.js"

export type JobTableFeedback = "up" | "down" | null

export type FixedHeaderFooterTableBadge = {
  label: string
  className: string
}

export type FixedHeaderFooterTableItem = {
  id: string
  company: string
  title: string
  postedLabel: string
  providerLabel: string
  feedReasonLabel: string
  applied: boolean
  queued: boolean
  applying: boolean
  applyProgress: number
  feedback: JobTableFeedback
  feedbackPending?: boolean
  titleBadge?: FixedHeaderFooterTableBadge
  statusBadge?: FixedHeaderFooterTableBadge
  dateLabel?: string
  dateSubLabel?: string
  dateSubValue?: string
}

type FixedHeaderFooterTableProps = {
  items: FixedHeaderFooterTableItem[]
  loading?: boolean
  expandedItemId?: string | null
  onRowClick: (itemId: string) => void
  onApply: (itemId: string) => void
  onThumbUp: (itemId: string) => void
  onThumbDown: (itemId: string) => void
  selectionMode?: boolean
  selectedItemIds?: string[]
  selectableItemIds?: string[]
  onToggleItemSelection?: (itemId: string) => void
  onToggleSelectAll?: () => void
  renderExpandedContent?: (itemId: string) => ReactNode
  renderActions?: (item: FixedHeaderFooterTableItem) => ReactNode
  companyColumnLabel?: string
  positionColumnLabel?: string
  dateColumnLabel?: string
  actionsColumnLabel?: string
  statusColumnLabel?: string
  defaultDateLabel?: string
  showPrimaryAction?: boolean
  showFeedbackActions?: boolean
  showChevron?: boolean
  showStatusColumn?: boolean
}

const easeOutQuint: [number, number, number, number] = [0.23, 1, 0.32, 1]
const expandSpring = {
  type: "spring" as const,
  damping: 34,
  stiffness: 380,
  mass: 0.8,
}

export default function FixedHeaderFooterTable({
  items,
  loading = false,
  expandedItemId,
  onRowClick,
  onApply,
  onThumbUp,
  onThumbDown,
  selectionMode = false,
  selectedItemIds = [],
  selectableItemIds = [],
  onToggleItemSelection,
  onToggleSelectAll,
  renderExpandedContent,
  renderActions,
  companyColumnLabel = "Company",
  positionColumnLabel = "Position",
  dateColumnLabel = "Date posted",
  actionsColumnLabel = "Quick actions",
  statusColumnLabel = "Status",
  defaultDateLabel = "Date posted",
  showPrimaryAction = true,
  showFeedbackActions = true,
  showChevron = true,
  showStatusColumn = false,
}: FixedHeaderFooterTableProps) {
  const selectedSet = new Set(selectedItemIds)
  const selectableSet = new Set(selectableItemIds)
  const selectableCount = selectableItemIds.length
  const allSelectableSelected = selectableCount > 0 && selectedItemIds.length === selectableCount

  return (
    <div className="bg-background w-full">
      <div className="flex h-full min-h-[34rem] flex-1 flex-col">
        <div className="flex-none">
          <Table className="w-full table-fixed border-separate border-spacing-0">
            <TableHeader className="sticky top-0 z-10 bg-background/90 backdrop-blur-sm">
              <TableRow>
                {selectionMode ? (
                  <TableHead className="w-[2.75rem] px-2">
                    <div className="flex items-center justify-center">
                      <input
                        type="checkbox"
                        aria-label={allSelectableSelected ? "Clear selection" : "Select all jobs"}
                        checked={allSelectableSelected}
                        disabled={selectableCount === 0}
                        onChange={() => onToggleSelectAll?.()}
                        className="desktop-jobs-table__checkbox"
                      />
                    </div>
                  </TableHead>
                ) : null}
                <TableHead
                  className={cn(
                    showStatusColumn ? (selectionMode ? "w-[18%]" : "w-[20%]") : selectionMode ? "w-[20%]" : "w-[22%]"
                  )}
                >
                  {companyColumnLabel}
                </TableHead>
                <TableHead
                  className={cn(
                    showStatusColumn ? (selectionMode ? "w-[27%]" : "w-[30%]") : selectionMode ? "w-[37%]" : "w-[38%]"
                  )}
                >
                  {positionColumnLabel}
                </TableHead>
                {showStatusColumn ? <TableHead className="w-[14%]">{statusColumnLabel}</TableHead> : null}
                <TableHead className="w-[18%]">{dateColumnLabel}</TableHead>
                <TableHead
                  className={cn(
                    showStatusColumn ? (selectionMode ? "w-[21%]" : "w-[18%]") : selectionMode ? "w-[25%]" : "w-[22%]",
                    "text-right"
                  )}
                >
                  {actionsColumnLabel}
                </TableHead>
              </TableRow>
            </TableHeader>
          </Table>
        </div>

        <div className="flex-1 overflow-y-auto">
          <Table className="w-full table-fixed border-separate border-spacing-0 [&_td]:border-border [&_tr:not(:last-child)_td]:border-b">
            <TableBody>
              {loading ? (
                Array.from({ length: 6 }).map((_, index) => (
                  <TableRow key={`skeleton-${index}`} className="hover:bg-transparent">
                    {selectionMode ? (
                      <TableCell className="px-2">
                        <div className="flex items-center justify-center">
                          <Skeleton className="size-4 rounded-none" />
                        </div>
                      </TableCell>
                    ) : null}
                    <TableCell>
                      <Skeleton className="h-5 w-[72%] rounded-none" />
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-0 flex-col gap-2">
                        <Skeleton className="h-5 w-[68%] rounded-none" />
                        <Skeleton className="h-3.5 w-[38%] rounded-none" />
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-0 flex-col gap-2">
                        <Skeleton className="h-3 w-16 rounded-none" />
                        <Skeleton className="h-4 w-28 rounded-none" />
                      </div>
                    </TableCell>
                    {showStatusColumn ? (
                      <TableCell>
                        <Skeleton className="h-7 w-20 rounded-none" />
                      </TableCell>
                    ) : null}
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Skeleton className="h-7 w-20 rounded-none" />
                        <Skeleton className="size-7 rounded-none" />
                        <Skeleton className="size-7 rounded-none" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : null}
              {!loading ? items.map((item) => {
                const isExpanded = expandedItemId === item.id
                const isSelectable = selectableSet.has(item.id)
                const isSelected = selectedSet.has(item.id)
                return (
                  <Fragment key={item.id}>
                    <TableRow
                      className={cn(
                        "cursor-pointer",
                        selectionMode && isSelected && "bg-muted",
                        isExpanded && "[&>td]:border-b-0",
                      )}
                      onClick={() => {
                        if (selectionMode) {
                          if (isSelectable) onToggleItemSelection?.(item.id)
                          return
                        }
                        onRowClick(item.id)
                      }}
                    >
                      {selectionMode ? (
                        <TableCell className="px-2" onClick={(event) => event.stopPropagation()}>
                          <div className="flex items-center justify-center">
                            <input
                              type="checkbox"
                              aria-label={`Select ${item.title}`}
                              checked={isSelected}
                              disabled={!isSelectable}
                              onChange={() => onToggleItemSelection?.(item.id)}
                              className="desktop-jobs-table__checkbox"
                            />
                          </div>
                        </TableCell>
                      ) : null}
                      <TableCell className="truncate font-medium">{item.company}</TableCell>
                      <TableCell>
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="flex min-w-0 flex-col gap-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate font-medium">{item.title}</span>
                              {item.titleBadge ? (
                                <span className={cn("shrink-0", item.titleBadge.className)}>{item.titleBadge.label}</span>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span className="truncate">{item.providerLabel}</span>
                              <span aria-hidden>•</span>
                              <span className="truncate">{item.feedReasonLabel}</span>
                            </div>
                            {item.applying ? <Progress value={item.applyProgress} className="mt-1 h-1.5" /> : null}
                          </div>
                          {showChevron ? (
                            <ChevronDown
                              className={cn(
                                "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                                isExpanded && "rotate-180",
                              )}
                            />
                          ) : null}
                        </div>
                      </TableCell>
                      {showStatusColumn ? (
                        <TableCell>
                          <div className="flex min-w-0 items-center">
                            {item.statusBadge ? <span className={cn("shrink-0", item.statusBadge.className)}>{item.statusBadge.label}</span> : null}
                          </div>
                        </TableCell>
                      ) : null}
                      <TableCell>
                        <div className="flex min-w-0 flex-col gap-1">
                          <span className="text-[0.72rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                            {item.dateLabel ?? defaultDateLabel}
                          </span>
                          <div className="flex items-center gap-2 text-foreground">
                            <CalendarDays className="size-3.5 text-muted-foreground" />
                            <span className="truncate">{item.postedLabel}</span>
                          </div>
                          {item.dateSubValue ? (
                            <div className="truncate text-[0.72rem] text-muted-foreground">
                              {item.dateSubLabel ? `${item.dateSubLabel} ${item.dateSubValue}` : item.dateSubValue}
                            </div>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div
                          className="flex items-center justify-end gap-1"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {renderActions ? renderActions(item) : null}
                          {!renderActions && showPrimaryAction ? (
                            <Button
                              size="sm"
                              onClick={() => onApply(item.id)}
                              disabled={item.applied || item.queued || item.applying}
                              className="cursor-pointer rounded-none"
                            >
                              {item.applied ? "Applied" : item.queued ? "Queued" : item.applying ? "Applying..." : "Apply"}
                            </Button>
                          ) : null}
                          {!renderActions && showFeedbackActions ? (
                            <>
                              <Button
                                type="button"
                                size="icon-sm"
                                variant={item.feedback === "up" ? "secondary" : "ghost"}
                                aria-label={`Thumbs up ${item.title}`}
                                onClick={() => onThumbUp(item.id)}
                                disabled={item.feedbackPending}
                                className={getFeedbackButtonClass(item.feedback, "up", item.feedbackPending)}
                              >
                                <ThumbsUp />
                              </Button>
                              <Button
                                type="button"
                                size="icon-sm"
                                variant={item.feedback === "down" ? "secondary" : "ghost"}
                                aria-label={`Thumbs down ${item.title}`}
                                onClick={() => onThumbDown(item.id)}
                                disabled={item.feedbackPending}
                                className={getFeedbackButtonClass(item.feedback, "down", item.feedbackPending)}
                              >
                                <ThumbsDown />
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                    {renderExpandedContent && !selectionMode ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell
                          colSpan={selectionMode ? (showStatusColumn ? 6 : 5) : showStatusColumn ? 5 : 4}
                          className="border-b-0 bg-transparent p-0"
                        >
                          <motion.div
                            initial={false}
                            animate={{
                              height: isExpanded ? "auto" : 0,
                              opacity: isExpanded ? 1 : 0,
                            }}
                            transition={{
                              height: expandSpring,
                              opacity: {
                                duration: isExpanded ? 0.2 : 0.12,
                                delay: isExpanded ? 0.08 : 0,
                                ease: easeOutQuint,
                              },
                            }}
                            className="overflow-hidden"
                            style={{ pointerEvents: isExpanded ? "auto" : "none" }}
                            aria-hidden={isExpanded ? undefined : true}
                          >
                            <motion.div
                              initial={false}
                              animate={{
                                opacity: isExpanded ? 1 : 0,
                                y: isExpanded ? 0 : -8,
                              }}
                              transition={{
                                duration: isExpanded ? 0.18 : 0.12,
                                delay: isExpanded ? 0.04 : 0,
                                ease: easeOutQuint,
                              }}
                              className="px-3 pb-4 pt-0"
                            >
                              {renderExpandedContent(item.id)}
                            </motion.div>
                          </motion.div>
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                )
              }) : null}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}

function getFeedbackButtonClass(feedback: JobTableFeedback, target: Exclude<JobTableFeedback, null>, pending?: boolean) {
  if (feedback !== target) {
    return cn(
      "cursor-pointer rounded-none border-transparent",
      pending && "pointer-events-none opacity-60"
    )
  }

  return cn(
    "cursor-pointer rounded-none border",
    target === "up"
      ? "border-[rgba(82,125,90,0.18)] bg-[rgba(116,170,124,0.16)] text-[rgb(55,92,61)] hover:bg-[rgba(116,170,124,0.22)] hover:text-[rgb(49,84,55)]"
      : "border-[rgba(166,103,98,0.18)] bg-[rgba(218,142,134,0.16)] text-[rgb(126,72,68)] hover:bg-[rgba(218,142,134,0.22)] hover:text-[rgb(112,62,58)]",
    pending && "pointer-events-none opacity-60"
  )
}
