// The server-authored Reg E disclosure/receipt content, one rendering per
// language. The API is the single source of truth for this copy
// (buildPrepaymentDisclosure / buildReceiptDisclosure) — the web renders these
// strings VERBATIM and never re-derives them. Shared by the review step (the
// prepayment disclosure) and the receipt view, so the two can't drift.
export interface RenderedDisclosure {
  title: string
  amountLines: string[]
  fxRateLine: string
  cancellationRights: string
  errorResolutionRights: string
  wrongAccountWarning: string
  contact: string
}

export type DisclosureContent = { en: RenderedDisclosure; es: RenderedDisclosure }

// The fields the receipt view consumes from GET /v1/transfers/:id/receipt.
export interface ReceiptResponse {
  content: DisclosureContent
  presentedAt: string
}

export function isRenderedDisclosure(v: unknown): v is RenderedDisclosure {
  if (typeof v !== 'object' || v === null) return false
  const d = v as Record<string, unknown>
  return (
    typeof d.title === 'string' &&
    Array.isArray(d.amountLines) &&
    d.amountLines.every((l) => typeof l === 'string') &&
    typeof d.fxRateLine === 'string' &&
    typeof d.cancellationRights === 'string' &&
    typeof d.errorResolutionRights === 'string' &&
    typeof d.wrongAccountWarning === 'string' &&
    typeof d.contact === 'string'
  )
}

// Shape guard before we trust a receipt 2xx body — same reasoning as
// isTransferShape / isQuoteShape: a gateway 200 + HTML slipping past the proxy
// must not reach the render as a TypeError. Requires both languages so a
// language switch never lands on undefined.
export function isReceiptContent(body: unknown): body is ReceiptResponse {
  if (typeof body !== 'object' || body === null) return false
  const b = body as Record<string, unknown>
  if (typeof b.presentedAt !== 'string') return false
  const c = b.content
  if (typeof c !== 'object' || c === null) return false
  const content = c as Record<string, unknown>
  return isRenderedDisclosure(content.en) && isRenderedDisclosure(content.es)
}
