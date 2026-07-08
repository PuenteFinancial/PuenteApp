export type KycStatus = 'not_started' | 'pending' | 'approved' | 'rejected' | 'manual_review'

export interface KycLinkResponse {
  url: string
}

export interface KycRejectionInfo {
  // Bridge's customer-facing reason strings (English) — display only,
  // never logged, never placed in URLs
  reasons: string[]
  retriesRemaining: number
}
