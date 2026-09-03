import type { KycStatus } from '@puente/shared'
import { supabaseAdmin } from './supabase.js'

// Append-only log of provider KYC verdicts (K6; audit 2026-09-02 corner 2).
// Two providers now verify the same sender — Stripe in our UI, Bridge via the
// Customers API relay — and users.kyc_status / stripe_kyc_tier* remain the
// derived "current" caches. Every writer here is BEST-EFFORT: an insert
// failure is logged (codes only) and never blocks the primary write, so the
// log can never take the money path down. Nothing reads it yet.

export type KycVerificationProvider = 'stripe_crypto' | 'bridge'
export type KycVerificationStatus = 'pending' | 'verified' | 'rejected' | 'review'
export type KycVerificationSource = 'relay' | 'webhook' | 'poll'

export interface KycVerificationInput {
  userId: string
  provider: KycVerificationProvider
  /** crc_… / Bridge customer id. Opaque, not PII. */
  providerRef: string | null
  status: KycVerificationStatus
  /** The provider's own word, kept beside our mapping (preview vocabularies drift). */
  providerStatus: string | null
  /** Stripe tier (L1/L2) or a Bridge endorsement name. */
  tier?: string | null
  /** Provider reason codes/labels only — never identity data. Bridge's
   *  `rejection_reasons[].reason` is its customer-facing explanation and is
   *  expected to be categorical ("ID photo could not be read"); the API
   *  bounds count and length but does not inspect content. Compliance
   *  review 2026-09-03: eyeball the first production verdicts to confirm no
   *  label ever carries a name or number before relying on this column. */
  reasons?: string[]
  source: KycVerificationSource
}

const MAX_REASONS = 10
const MAX_REASON_LENGTH = 200

// Bridge's customer status, already mapped onto users.kyc_status, onto the
// log's vocabulary.
export function bridgeKycToVerificationStatus(kyc: KycStatus): KycVerificationStatus {
  switch (kyc) {
    case 'approved':
      return 'verified'
    case 'rejected':
      return 'rejected'
    case 'manual_review':
      return 'review'
    default:
      return 'pending'
  }
}

// The Stripe customers poll, as cacheKycStatus derives it: a tier exists only
// when a verification is `verified`; otherwise the first entry's status
// decides between rejected and still-pending.
export function stripeTierToVerificationStatus(
  tier: string | null,
  anyStatus: string | null,
): KycVerificationStatus {
  if (tier) return 'verified'
  if (anyStatus && /reject|fail|denied/i.test(anyStatus)) return 'rejected'
  if (anyStatus && /review/i.test(anyStatus)) return 'review'
  return 'pending'
}

interface Logger {
  error(obj: Record<string, unknown>, msg: string): void
}

// Insert one verdict row. Returns whether it landed; never throws.
export async function recordKycVerification(
  input: KycVerificationInput,
  log: Logger,
): Promise<boolean> {
  const reasons = (input.reasons ?? [])
    .filter((r): r is string => typeof r === 'string' && r.length > 0)
    .slice(0, MAX_REASONS)
    .map((r) => r.slice(0, MAX_REASON_LENGTH))

  try {
    const { error } = await supabaseAdmin.from('kyc_verifications').insert({
      user_id: input.userId,
      provider: input.provider,
      provider_ref: input.providerRef,
      status: input.status,
      provider_status: input.providerStatus,
      tier: input.tier ?? null,
      reasons,
      source: input.source,
    })
    if (error) {
      log.error(
        { userId: input.userId, provider: input.provider, supabaseError: error.code },
        'kyc verification log insert failed',
      )
      return false
    }
    return true
  } catch (err) {
    log.error(
      {
        userId: input.userId,
        provider: input.provider,
        err: err instanceof Error ? err.name : 'unknown',
      },
      'kyc verification log insert threw',
    )
    return false
  }
}
