export type ConsentType = 'esign' | 'puente_tos' | 'puente_privacy' | 'bridge_tos'

export type ConsentLocale = 'en' | 'es'

// One (type, version) pair — what a document IS for consent purposes.
export interface ConsentDocument {
  type: ConsentType
  version: string
}

// A recorded grant, as returned by GET /v1/users/me/consents.
export interface ConsentRecord extends ConsentDocument {
  locale: ConsentLocale
  consentedAt: string // ISO timestamp
}

export interface ConsentsResponse {
  required: ConsentDocument[]
  granted: ConsentRecord[]
  missing: ConsentDocument[]
}

// The consents every user must hold CURRENT versions of before proceeding
// past onboarding (the /continue router enforces this). Versions are the
// document's "Last updated" date; bumping one here is what forces re-consent
// app-wide. The K7 prod flip swaps in counsel-reviewed docs by bumping these.
//
// bridge_tos is deliberately absent: it is collected at first send, only on
// paths that need it, with signed_agreement_id as evidence (K-lane decision 5).
export const REQUIRED_CONSENTS: readonly ConsentDocument[] = [
  { type: 'esign', version: '2026-08-27' },
  { type: 'puente_tos', version: '2026-07-21' },
  { type: 'puente_privacy', version: '2026-07-21' },
]
