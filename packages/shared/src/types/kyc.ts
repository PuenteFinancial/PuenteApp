export type KycStatus = 'not_started' | 'pending' | 'approved' | 'rejected' | 'manual_review'

export interface KycLinkResponse {
  url: string
}
