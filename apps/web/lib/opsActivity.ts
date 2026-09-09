// Ops board slice 2: the activity record read back. Pure types + guards +
// derivations, no DOM (same extract-to-lib convention as opsOverview.ts).
// Two shapes on purpose: the board FEED row (six fields, no note) and the
// detail HISTORY row (note + derived string changes + request id). Both are
// hand-mirrored from the API (docs/api-contract.md); the guards are the
// runtime contract check, and both surfaces treat an absent `activity` as
// "not reported" (deploy skew), never as "nobody did anything".

import type { BadgeTone } from '@/lib/transferState'

export const OPS_ACTION_KINDS = [
  'hold_release',
  'refund',
  'cancellation_resolve',
  'manual_funding',
  'deposit_instructions_attach',
  'deposit_landed',
  'float_topup',
] as const
export type OpsActionKind = (typeof OPS_ACTION_KINDS)[number]

export interface OpsActivityFeedRow {
  id: string
  createdAt: string
  actor: string
  action: string
  /** Null for treasury-level actions (float_topup). */
  transferId: string | null
  reason: string | null
}

export interface OpsActivityChange {
  key: string
  before: string | null
  after: string | null
}

export interface OpsActivityRow extends OpsActivityFeedRow {
  note: string | null
  changes: OpsActivityChange[]
  requestId: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const nullableString = (v: unknown) => v === null || typeof v === 'string'

export function isOpsActivityFeedRowShape(v: unknown): v is OpsActivityFeedRow {
  if (!isRecord(v)) return false
  return (
    typeof v.id === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.actor === 'string' &&
    typeof v.action === 'string' &&
    nullableString(v.transferId) &&
    nullableString(v.reason)
  )
}

export function isOpsActivityRowShape(v: unknown): v is OpsActivityRow {
  if (!isOpsActivityFeedRowShape(v)) return false
  const r = v as unknown as Record<string, unknown>
  if (!nullableString(r.note) || !nullableString(r.requestId)) return false
  if (!Array.isArray(r.changes)) return false
  return r.changes.every(
    (c) => isRecord(c) && typeof c.key === 'string' && nullableString(c.before) && nullableString(c.after),
  )
}

/** Is this one of the action kinds the copy table knows? Unknown kinds render as their raw name. */
export function isKnownActionKind(action: string): action is OpsActionKind {
  return (OPS_ACTION_KINDS as readonly string[]).includes(action)
}

/**
 * `ops:<uuid>` → `ops:1c23cf20`. Actors are attribution, not PII, but a full
 * uuid is noise on a feed line; the detail page has the same eight chars and
 * the request id beside it if anyone needs the rest.
 */
export function actorShort(actor: string): string {
  const [prefix, rest] = actor.includes(':') ? [actor.slice(0, actor.indexOf(':')), actor.slice(actor.indexOf(':') + 1)] : [null, actor]
  const short = rest.length > 8 ? rest.slice(0, 8) : rest
  return prefix ? `${prefix}:${short}` : short
}

/** Money-moving actions read as progress; the rest are neutral bookkeeping. */
export function activityTone(action: string): BadgeTone {
  return action === 'refund' || action === 'hold_release' ? 'progress' : 'neutral'
}

/** `key: before → after`, with absent sides rendered as an em dash. */
export function formatChange(change: OpsActivityChange): string {
  return `${change.key}: ${change.before ?? '—'} → ${change.after ?? '—'}`
}
