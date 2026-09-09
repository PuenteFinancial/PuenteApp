// Pure state machine for the Bridge identity leg of the Checkout Sessions pay
// step (C3 — docs/prds/checkout-sessions-rail.md).
//
// WHY THIS EXISTS. Bridge makes the payout, so Bridge must hold a verified
// customer for the sender before any money is taken. On the Stripe crypto rail
// that verification is a by-product: Stripe's onramp refuses an unverified
// consumer, so by the time the relay runs the sender is already L1 and the
// machine in cryptoPayStep.ts has eight Link/Stripe steps in front of it. The
// Checkout rail has none of that — a card or bank charge needs no identity
// check of Stripe's — which makes Bridge the SOLE verifier and this leg the
// whole of identity:
//
//   accept Bridge's terms → enter DOB + tax ID once → Bridge decides → pay
//
// It is a SEPARATE machine, not a mode of the crypto one, for two reasons that
// both point the same way: the crypto machine is the most drive-proven code in
// the repo and must not be destabilized to serve a rail it will outlive, and
// PRD §4 keeps it in the tree as a real fallback until the new rail has moved
// production money. What the two genuinely share — the identity values, their
// normalization, the poll bound — lives in lib/bridgeIdentity.
//
// PII RULE (decision 3, ratified 2026-08-27; degrade clause 2026-09-02). The
// tax ID and DOB go through our API to Bridge exactly once and are stored
// nowhere. Here that means: they live in ONE context field (`relayValues`)
// between the form and the relay, they are dropped the instant the relay
// answers whatever it says, and the only thing that may carry them out of this
// module is the `relay` effect. Captures carry a transfer id and codes — never
// a value, never a message. The guard test asserts all of it.
//
// The host (CheckoutIdentityStep.tsx) dispatches events, runs the returned
// effects, and fires the returned captures. It decides nothing.

import {
  BRIDGE_POLL_TIMEOUT_TICKS,
  invalidIdentityFields,
  relayValuesFrom,
  type IdentityFormValues,
  type RelayValues,
} from './bridgeIdentity'

export type CheckoutIdentityFailKind =
  /** Bridge already holds a verification for this tax ID (K6 decision 9:
   *  hard stop, support route, never auto-link, never say whose). */
  | 'duplicate_identity'
  /** Bridge refused on something a document cannot cure. */
  | 'kyc_rejected'
  | 'retryable'

export type CheckoutIdentityView =
  /** First read of GET /users/me. */
  | { step: 'loading' }
  | { step: 'boot_error' }
  /** Bridge's hosted terms click-through (K6 decision 1: ToS first). */
  | { step: 'bridge_tos' }
  /** DOB + tax ID. `correction` = Bridge refused the create and one
   *  correction is offered; the values are gone either way, so this form is
   *  always a fresh entry, never a prefill. */
  | { step: 'identity_form'; reason: 'first' | 'correction'; invalid: string[] }
  /** POST relay in flight. */
  | { step: 'relaying' }
  /** Bounded poll of GET /users/me for Bridge's verdict. */
  | { step: 'bridge_polling' }
  /** Past the bound, or manual review: come back later. The draft persists. */
  | { step: 'bridge_wait' }
  /** Bridge rejected; fetching the reasons to pick Persona vs terminal. */
  | { step: 'bridge_rejection' }
  /** The hosted document fallback. null retries = the detail could not be
   *  read; offered anyway, because the server bounds retries regardless. */
  | { step: 'bridge_persona'; retriesRemaining: number | null }
  | { step: 'failed'; kind: CheckoutIdentityFailKind }
  /** Bridge has an approved customer: the host renders the Payment Element. */
  | { step: 'ready' }

export interface CheckoutIdentityContext {
  transferId: string
  bridgeCustomerId: string | null
  kycStatus: string
  /** The CURRENT Bridge ToS version is on file. Evidence-based, from
   *  GET /users/me — not "we redirected them once". */
  bridgeTosAccepted: boolean
  pollCount: number
  /** THE ONLY PLACE identity values live between the form and the relay. */
  relayValues: RelayValues | null
}

export interface ApiFailure {
  status: number
  code: string | null
  /** details[0].path — the relay's 409 names which precondition failed
   *  (`bridge_tos` | `signed_agreement_id`). */
  path: string | null
}

export type CheckoutIdentityEvent =
  | { type: 'BOOT_OK'; bridgeCustomerId: string | null; kycStatus: string; tosAccepted: boolean }
  | { type: 'BOOT_FAILED' }
  | { type: 'TOS_CONTINUE' }
  | { type: 'REDIRECT_FAILED' }
  | { type: 'IDENTITY_SUBMIT'; values: IdentityFormValues }
  | { type: 'RELAY_OK'; bridgeCustomerId: string; status: string }
  | { type: 'RELAY_ERROR'; failure: ApiFailure }
  | { type: 'USERS_ME_RESULT'; bridgeCustomerId: string | null; kycStatus: string }
  | { type: 'USERS_ME_FAILED' }
  | { type: 'RECHECK' }
  | { type: 'REJECTION_RESULT'; retriesRemaining: number | null }
  | { type: 'PERSONA_CONTINUE' }
  | { type: 'RETRY' }

export type CheckoutIdentityEffect =
  | { kind: 'fetch_users_me' }
  | { kind: 'tos_redirect' }
  /** The ONE effect allowed to carry the identity values. */
  | { kind: 'relay' }
  | { kind: 'poll_users_me' }
  | { kind: 'fetch_rejection' }
  | { kind: 'persona_redirect' }

export interface FunnelCapture {
  event: string
  props: Record<string, string | number>
}

export interface CheckoutIdentityState {
  view: CheckoutIdentityView
  ctx: CheckoutIdentityContext
}

export interface Transition {
  state: CheckoutIdentityState
  effects: CheckoutIdentityEffect[]
  captures: FunnelCapture[]
}

export function initialCheckoutIdentityState(transferId: string): CheckoutIdentityState {
  return {
    view: { step: 'loading' },
    ctx: {
      transferId,
      bridgeCustomerId: null,
      kycStatus: 'not_started',
      bridgeTosAccepted: false,
      pollCount: 0,
      relayValues: null,
    },
  }
}

export const initialEffects: CheckoutIdentityEffect[] = [{ kind: 'fetch_users_me' }]

function cap(
  ctx: CheckoutIdentityContext,
  event: string,
  props: Record<string, string | number> = {},
): FunnelCapture {
  return { event, props: { transfer_id: ctx.transferId, ...props } }
}

/** Forget the identity values. Called the moment they can no longer be
 *  relayed — which is as soon as the relay answers, whatever it answers. */
function dropRelayValues(ctx: CheckoutIdentityContext): CheckoutIdentityContext {
  return ctx.relayValues ? { ...ctx, relayValues: null } : ctx
}

/**
 * Where the sender belongs given what Bridge currently thinks of them. The one
 * place kyc_status is interpreted, so boot, the relay's answer and the poll
 * cannot drift apart.
 *
 * `approved` is the ONLY status that reaches the Payment Element. A sender
 * whose verification is still open must not be able to pay: their money would
 * be taken for a payout Bridge may refuse to make.
 */
function routeByBridgeStatus(ctx: CheckoutIdentityContext, kycStatus: string): Transition {
  if (kycStatus === 'approved') {
    return {
      state: { view: { step: 'ready' }, ctx },
      effects: [],
      captures: [cap(ctx, 'send_bridge_kyc_approved')],
    }
  }
  if (kycStatus === 'rejected') {
    return {
      state: { view: { step: 'bridge_rejection' }, ctx },
      effects: [{ kind: 'fetch_rejection' }],
      captures: [cap(ctx, 'send_bridge_kyc_rejected')],
    }
  }
  if (kycStatus === 'manual_review') {
    return {
      state: { view: { step: 'bridge_wait' }, ctx },
      effects: [],
      captures: [cap(ctx, 'send_bridge_wait', { reason: 'manual_review' })],
    }
  }
  // Created but undecided: poll in place.
  return {
    state: { view: { step: 'bridge_polling' }, ctx: { ...ctx, pollCount: 0 } },
    effects: [{ kind: 'poll_users_me' }],
    captures: [],
  }
}

/** One more Bridge poll, or the come-back-later card at the bound. */
function pollTick(ctx: CheckoutIdentityContext): Transition {
  const next = { ...ctx, pollCount: ctx.pollCount + 1 }
  if (next.pollCount >= BRIDGE_POLL_TIMEOUT_TICKS) {
    return {
      state: { view: { step: 'bridge_wait' }, ctx: next },
      effects: [],
      captures: [cap(next, 'send_bridge_wait', { reason: 'timeout' })],
    }
  }
  return {
    state: { view: { step: 'bridge_polling' }, ctx: next },
    effects: [{ kind: 'poll_users_me' }],
    captures: [],
  }
}

/**
 * Where a boot lands. Called on first load AND on every remount, so it has to
 * be idempotent and safe to re-enter — a sender who reloads mid-flow must land
 * somewhere true, never on a form that re-does work Bridge already has.
 */
function routeBoot(
  ctx: CheckoutIdentityContext,
  bridgeCustomerId: string | null,
  kycStatus: string,
  tosAccepted: boolean,
): Transition {
  const next = { ...ctx, bridgeCustomerId, kycStatus, bridgeTosAccepted: tosAccepted }
  // A customer exists: identity is Bridge's business now, whatever the status.
  // Never show the ToS card or the form again — the relay would no-op anyway,
  // and asking for a tax ID we cannot use reads as if it were lost.
  if (bridgeCustomerId) return routeByBridgeStatus(next, kycStatus)
  if (!tosAccepted) {
    return {
      state: { view: { step: 'bridge_tos' }, ctx: next },
      effects: [],
      captures: [cap(next, 'send_bridge_tos_viewed', { reason: 'first' })],
    }
  }
  return {
    state: { view: { step: 'identity_form', reason: 'first', invalid: [] }, ctx: next },
    effects: [],
    captures: [cap(next, 'send_relay_form_viewed', { reason: 'first' })],
  }
}

export function transition(
  state: CheckoutIdentityState,
  event: CheckoutIdentityEvent,
): Transition {
  const { view, ctx } = state
  const stay = (
    effects: CheckoutIdentityEffect[] = [],
    captures: FunnelCapture[] = [],
  ): Transition => ({ state, effects, captures })

  switch (event.type) {
    case 'BOOT_OK':
      if (view.step !== 'loading' && view.step !== 'boot_error') return stay()
      return routeBoot(ctx, event.bridgeCustomerId, event.kycStatus, event.tosAccepted)

    case 'BOOT_FAILED':
      if (view.step !== 'loading' && view.step !== 'boot_error') return stay()
      return { state: { view: { step: 'boot_error' }, ctx }, effects: [], captures: [] }

    case 'TOS_CONTINUE':
      if (view.step !== 'bridge_tos') return stay()
      // The effect sets the return cookies and navigates away. Nothing to
      // keep: the return leg records the consent and reboots this machine,
      // which then finds tosAccepted true and shows the form.
      return stay([{ kind: 'tos_redirect' }], [cap(ctx, 'send_bridge_tos_started')])

    case 'REDIRECT_FAILED':
      return {
        state: { view: { step: 'failed', kind: 'retryable' }, ctx },
        effects: [],
        captures: [cap(ctx, 'send_payment_failed', { code: 'bridge_redirect_failed' })],
      }

    case 'IDENTITY_SUBMIT': {
      if (view.step !== 'identity_form') return stay()
      const invalid = invalidIdentityFields(event.values)
      if (invalid.length > 0) {
        // Field NAMES only — never the values, not even into local state we
        // then render.
        return {
          state: {
            view: { step: 'identity_form', reason: view.reason, invalid },
            ctx,
          },
          effects: [],
          captures: [],
        }
      }
      return {
        state: {
          view: { step: 'relaying' },
          ctx: { ...ctx, relayValues: relayValuesFrom(event.values) },
        },
        effects: [{ kind: 'relay' }],
        captures: [cap(ctx, 'send_bridge_relay_started', { reason: view.reason })],
      }
    }

    case 'RELAY_OK': {
      if (view.step !== 'relaying') return stay()
      // The values have done their one job. The customer now exists (or
      // already did — the route no-ops), so route on Bridge's status.
      const next = {
        ...dropRelayValues(ctx),
        bridgeCustomerId: event.bridgeCustomerId,
        kycStatus: event.status,
      }
      const created = cap(next, 'send_bridge_customer_created', { status: event.status })
      const t = routeByBridgeStatus(next, event.status)
      return { ...t, captures: [created, ...t.captures] }
    }

    case 'RELAY_ERROR': {
      if (view.step !== 'relaying') return stay()
      // Whatever the answer, the values are gone; every path that needs them
      // again re-enters them through the form.
      const next = dropRelayValues(ctx)
      const f = event.failure
      const failed = cap(next, 'send_bridge_relay_failed', {
        code: f.code ?? `http_${f.status}`,
        ...(f.path ? { path: f.path } : {}),
      })
      if (f.status === 409 && f.code === 'duplicate_identity') {
        return {
          state: { view: { step: 'failed', kind: 'duplicate_identity' }, ctx: next },
          effects: [],
          captures: [failed],
        }
      }
      if (f.status === 422) {
        // Bridge refused the create on the values themselves: one correction.
        return {
          state: {
            view: { step: 'identity_form', reason: 'correction', invalid: [] },
            ctx: next,
          },
          effects: [],
          captures: [failed, cap(next, 'send_relay_form_viewed', { reason: 'correction' })],
        }
      }
      if (f.status === 409 && f.code === 'conflict') {
        // bridge_tos missing, or the agreement id was consumed (pointer
        // already cleared server-side): the click-through runs again.
        return {
          state: {
            view: { step: 'bridge_tos' },
            ctx: { ...next, bridgeTosAccepted: false },
          },
          effects: [],
          captures: [failed, cap(next, 'send_bridge_tos_viewed', { reason: f.path ?? 'conflict' })],
        }
      }
      // 403 lands here too. On THIS rail the relay's precondition is consents,
      // not a Stripe tier, and consents are taken during onboarding — so a 403
      // means the server and the client disagree about something this surface
      // cannot fix by asking again. Retryable card, not a silent loop.
      return {
        state: { view: { step: 'failed', kind: 'retryable' }, ctx: next },
        effects: [],
        captures: [failed],
      }
    }

    case 'USERS_ME_RESULT': {
      if (view.step !== 'bridge_polling') return stay()
      const next = {
        ...ctx,
        bridgeCustomerId: event.bridgeCustomerId,
        kycStatus: event.kycStatus,
      }
      const settled =
        event.kycStatus === 'approved' ||
        event.kycStatus === 'rejected' ||
        event.kycStatus === 'manual_review'
      if (event.bridgeCustomerId && settled) return routeByBridgeStatus(next, event.kycStatus)
      return pollTick(next)
    }

    case 'USERS_ME_FAILED':
      if (view.step !== 'bridge_polling') return stay()
      // A transient read failure counts toward the same bound — the wait card
      // is the honest vent either way.
      return pollTick(ctx)

    case 'RECHECK':
      if (view.step !== 'bridge_wait') return stay()
      return {
        state: { view: { step: 'bridge_polling' }, ctx: { ...ctx, pollCount: 0 } },
        effects: [{ kind: 'poll_users_me' }],
        captures: [cap(ctx, 'send_bridge_recheck')],
      }

    case 'REJECTION_RESULT': {
      if (view.step !== 'bridge_rejection') return stay()
      // retriesRemaining === 0 is the one value that means "no document
      // fallback left"; null means the detail could not be read, and the offer
      // stands because the server bounds retries anyway. Conflating the two
      // would strand a sender who still had a way through.
      if (event.retriesRemaining === 0) {
        return {
          state: { view: { step: 'failed', kind: 'kyc_rejected' }, ctx },
          effects: [],
          captures: [],
        }
      }
      return {
        state: {
          view: { step: 'bridge_persona', retriesRemaining: event.retriesRemaining },
          ctx,
        },
        effects: [],
        captures: [cap(ctx, 'send_bridge_persona_offered')],
      }
    }

    case 'PERSONA_CONTINUE':
      if (view.step !== 'bridge_persona') return stay()
      return stay([{ kind: 'persona_redirect' }], [cap(ctx, 'send_bridge_persona_started')])

    case 'RETRY':
      if (view.step !== 'boot_error' && view.step !== 'failed') return stay()
      // Only the retryable kind re-boots. A duplicate identity and a spent
      // rejection are terminal by design (K6 decision 9) — re-reading
      // /users/me would land right back here and read as a broken button.
      if (view.step === 'failed' && view.kind !== 'retryable') return stay()
      return {
        state: { view: { step: 'loading' }, ctx: { ...ctx, pollCount: 0 } },
        effects: [{ kind: 'fetch_users_me' }],
        captures: [],
      }
  }
}
