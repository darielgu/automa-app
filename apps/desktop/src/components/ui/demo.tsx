"use client"

import FixedHeaderFooterTable from "@/components/ui/fixed-header-footer-table.js"

export default function DemoOne() {
  return (
    <FixedHeaderFooterTable
      items={[]}
      onRowClick={() => undefined}
      onApply={() => undefined}
      onThumbUp={() => undefined}
      onThumbDown={() => undefined}
    />
  )
}
