'use client'

import { useEffect, useRef } from 'react'

// Mounts an SDK-owned HTMLElement (the Link authenticate modal, the payment
// collection element). The effect keys on ELEMENT IDENTITY only — the
// tracker's 5s poll re-renders the whole pay tree and must never remount a
// live SDK surface mid-flow (the OnrampWidget hazard rule, K5 edition).
export default function SdkElementHost({ element }: { element: HTMLElement | null }) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container || !element) return
    container.replaceChildren(element)
    return () => {
      container.replaceChildren()
    }
  }, [element])

  if (!element) return null
  return <div ref={containerRef} />
}
