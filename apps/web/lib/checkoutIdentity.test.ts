import { describe, it, expect } from 'vitest'
import {
  initialCheckoutIdentityState,
  transition,
  type CheckoutIdentityEvent,
  type CheckoutIdentityState,
} from './checkoutIdentity'
import type { IdentityFormValues } from './bridgeIdentity'

const TRANSFER = 'transfer-1'

// The values the PII guard hunts for. If either shows up in a capture or an
// effect, the custody rule is broken.
const DOB_PARTS = { dobMonth: '3', dobDay: '21', dobYear: '1987' }
const SSN = '078-05-1120'
const SSN_DIGITS = '078051120'
const VALID: IdentityFormValues = { ...DOB_PARTS, taxId: SSN, taxIdType: 'ssn' }

const boot = (
  over: Partial<{ bridgeCustomerId: string | null; kycStatus: string; tosAccepted: boolean }> = {},
): CheckoutIdentityEvent => ({
  type: 'BOOT_OK',
  bridgeCustomerId: null,
  kycStatus: 'not_started',
  tosAccepted: false,
  ...over,
})

/** Drive a list of events from a fresh machine, collecting everything. */
function drive(events: CheckoutIdentityEvent[]) {
  let state: CheckoutIdentityState = initialCheckoutIdentityState(TRANSFER)
  const captures = []
  const effects = []
  const states = [state]
  for (const event of events) {
    const t = transition(state, event)
    state = t.state
    captures.push(...t.captures)
    effects.push(...t.effects)
    states.push(state)
  }
  return { state, captures, effects, states }
}

describe('boot routing', () => {
  it('no Bridge customer and no terms on file → the ToS click-through', () => {
    const { state } = drive([boot()])
    expect(state.view).toEqual({ step: 'bridge_tos' })
  })

  it('terms accepted but no customer → the identity form', () => {
    const { state } = drive([boot({ tosAccepted: true })])
    expect(state.view).toEqual({ step: 'identity_form', reason: 'first', invalid: [] })
  })

  it('an approved customer goes straight to the pay form', () => {
    const { state } = drive([boot({ bridgeCustomerId: 'cust_1', kycStatus: 'approved' })])
    expect(state.view).toEqual({ step: 'ready' })
  })

  it('an existing customer NEVER re-asks for the tax ID, whatever its status', () => {
    // Bridge already has the identity; asking again reads as if it were lost,
    // and the relay would no-op anyway.
    for (const kycStatus of ['pending', 'approved', 'rejected', 'manual_review', 'anything']) {
      const { state } = drive([boot({ bridgeCustomerId: 'cust_1', kycStatus, tosAccepted: false })])
      expect(state.view.step, kycStatus).not.toBe('identity_form')
      expect(state.view.step, kycStatus).not.toBe('bridge_tos')
    }
  })

  it('a customer under manual review waits; a rejected one fetches the reasons', () => {
    expect(drive([boot({ bridgeCustomerId: 'c', kycStatus: 'manual_review' })]).state.view).toEqual({
      step: 'bridge_wait',
    })
    const rejected = drive([boot({ bridgeCustomerId: 'c', kycStatus: 'rejected' })])
    expect(rejected.state.view).toEqual({ step: 'bridge_rejection' })
    expect(rejected.effects).toContainEqual({ kind: 'fetch_rejection' })
  })

  it('a failed boot is retryable and re-reads', () => {
    const { state } = drive([{ type: 'BOOT_FAILED' }])
    expect(state.view).toEqual({ step: 'boot_error' })
    const retried = transition(state, { type: 'RETRY' })
    expect(retried.state.view).toEqual({ step: 'loading' })
    expect(retried.effects).toContainEqual({ kind: 'fetch_users_me' })
  })
})

describe('only an approved Bridge customer can reach the Payment Element', () => {
  // The money invariant of this slice: a sender whose verification is still
  // open must not be able to pay, or we take money for a payout Bridge may
  // refuse to make.
  const NOT_APPROVED = ['not_started', 'pending', 'manual_review', 'rejected', 'under_review', '']

  it('no other status routes to ready — from boot', () => {
    for (const kycStatus of NOT_APPROVED) {
      const { state } = drive([boot({ bridgeCustomerId: 'cust_1', kycStatus })])
      expect(state.view.step, kycStatus).not.toBe('ready')
    }
  })

  it('no other status routes to ready — from the relay answering', () => {
    for (const status of NOT_APPROVED) {
      const { state } = drive([
        boot({ tosAccepted: true }),
        { type: 'IDENTITY_SUBMIT', values: VALID },
        { type: 'RELAY_OK', bridgeCustomerId: 'cust_1', status },
      ])
      expect(state.view.step, status).not.toBe('ready')
    }
  })

  it('no other status routes to ready — from the poll', () => {
    for (const kycStatus of NOT_APPROVED) {
      const { state } = drive([
        boot({ bridgeCustomerId: 'cust_1', kycStatus: 'pending' }),
        { type: 'USERS_ME_RESULT', bridgeCustomerId: 'cust_1', kycStatus },
      ])
      expect(state.view.step, kycStatus).not.toBe('ready')
    }
  })
})

describe('the identity form', () => {
  it('reports invalid FIELD NAMES and never starts a relay', () => {
    const { state, effects } = drive([
      boot({ tosAccepted: true }),
      { type: 'IDENTITY_SUBMIT', values: { ...VALID, dobMonth: '13', taxId: '123' } },
    ])
    expect(state.view).toEqual({
      step: 'identity_form',
      reason: 'first',
      invalid: ['dobMonth', 'taxId'],
    })
    expect(effects).not.toContainEqual({ kind: 'relay' })
  })

  it('a valid submit relays once and holds the values only until it answers', () => {
    const submitted = drive([
      boot({ tosAccepted: true }),
      { type: 'IDENTITY_SUBMIT', values: VALID },
    ])
    expect(submitted.state.view).toEqual({ step: 'relaying' })
    expect(submitted.effects).toContainEqual({ kind: 'relay' })
    expect(submitted.state.ctx.relayValues).toEqual({
      dob: '1987-03-21',
      taxIdType: 'ssn',
      taxId: SSN_DIGITS,
    })

    const answered = transition(submitted.state, {
      type: 'RELAY_OK',
      bridgeCustomerId: 'cust_1',
      status: 'approved',
    })
    expect(answered.state.ctx.relayValues).toBeNull()
  })
})

describe('relay failures', () => {
  const submitted = () =>
    drive([boot({ tosAccepted: true }), { type: 'IDENTITY_SUBMIT', values: VALID }]).state

  const fail = (status: number, code: string | null, path: string | null = null) =>
    transition(submitted(), { type: 'RELAY_ERROR', failure: { status, code, path } })

  it('a duplicate identity is terminal and routes to support — never auto-linked', () => {
    const t = fail(409, 'duplicate_identity')
    expect(t.state.view).toEqual({ step: 'failed', kind: 'duplicate_identity' })
    // And it does not offer a retry that would just land here again.
    expect(transition(t.state, { type: 'RETRY' }).state.view).toEqual(t.state.view)
  })

  it('a 422 offers exactly one correction', () => {
    expect(fail(422, 'validation_error').state.view).toEqual({
      step: 'identity_form',
      reason: 'correction',
      invalid: [],
    })
  })

  it('a 409 conflict sends them back through the terms, and forgets the stale acceptance', () => {
    const t = fail(409, 'conflict', 'bridge_tos')
    expect(t.state.view).toEqual({ step: 'bridge_tos' })
    expect(t.state.ctx.bridgeTosAccepted).toBe(false)
  })

  it('anything else is the retryable card — including the 403 this rail should not see', () => {
    for (const [status, code] of [
      [403, 'forbidden'],
      [500, 'internal_error'],
      [502, 'provider_unavailable'],
    ] as const) {
      expect(fail(status, code).state.view, String(status)).toEqual({
        step: 'failed',
        kind: 'retryable',
      })
    }
  })

  it('EVERY failure drops the identity values', () => {
    for (const [status, code] of [
      [409, 'duplicate_identity'],
      [422, 'validation_error'],
      [409, 'conflict'],
      [403, 'forbidden'],
      [500, null],
    ] as const) {
      expect(fail(status, code).state.ctx.relayValues, `${status}/${code}`).toBeNull()
    }
  })
})

describe('the Bridge poll', () => {
  it('keeps polling while undecided, then shows the come-back-later card at the bound', () => {
    let state = drive([boot({ bridgeCustomerId: 'c', kycStatus: 'pending' })]).state
    expect(state.view).toEqual({ step: 'bridge_polling' })
    for (let i = 0; i < 40; i++) {
      state = transition(state, {
        type: 'USERS_ME_RESULT',
        bridgeCustomerId: 'c',
        kycStatus: 'pending',
      }).state
    }
    expect(state.view).toEqual({ step: 'bridge_wait' })
  })

  it('a transient read failure counts toward the same bound rather than spinning forever', () => {
    let state = drive([boot({ bridgeCustomerId: 'c', kycStatus: 'pending' })]).state
    for (let i = 0; i < 40; i++) {
      state = transition(state, { type: 'USERS_ME_FAILED' }).state
    }
    expect(state.view).toEqual({ step: 'bridge_wait' })
  })

  it('recheck restarts the poll from zero', () => {
    const state = drive([boot({ bridgeCustomerId: 'c', kycStatus: 'manual_review' })]).state
    expect(state.view).toEqual({ step: 'bridge_wait' })
    const t = transition(state, { type: 'RECHECK' })
    expect(t.state.view).toEqual({ step: 'bridge_polling' })
    expect(t.state.ctx.pollCount).toBe(0)
    expect(t.effects).toContainEqual({ kind: 'poll_users_me' })
  })
})

describe('rejection and the document fallback', () => {
  const rejected = () => drive([boot({ bridgeCustomerId: 'c', kycStatus: 'rejected' })]).state

  it('offers Persona when retries remain', () => {
    expect(transition(rejected(), { type: 'REJECTION_RESULT', retriesRemaining: 2 }).state.view)
      .toEqual({ step: 'bridge_persona', retriesRemaining: 2 })
  })

  it('offers it when the detail could NOT be read — null is not zero', () => {
    // The server bounds retries regardless, so an unreadable detail must not
    // strand a sender who still had a way through.
    expect(transition(rejected(), { type: 'REJECTION_RESULT', retriesRemaining: null }).state.view)
      .toEqual({ step: 'bridge_persona', retriesRemaining: null })
  })

  it('zero retries is terminal', () => {
    expect(transition(rejected(), { type: 'REJECTION_RESULT', retriesRemaining: 0 }).state.view)
      .toEqual({ step: 'failed', kind: 'kyc_rejected' })
  })

  it('a spent rejection does not offer a retry button that goes nowhere', () => {
    const terminal = transition(rejected(), { type: 'REJECTION_RESULT', retriesRemaining: 0 }).state
    expect(transition(terminal, { type: 'RETRY' }).state.view).toEqual(terminal.view)
  })
})

describe('PII custody — the identity values leave through exactly one door', () => {
  // Drive every path that touches the values and prove the DOB and the tax ID
  // appear in NO capture and NO effect. The `relay` effect carries them by
  // reading ctx at execution time, which is why it is a bare {kind} marker.
  const paths: CheckoutIdentityEvent[][] = [
    [boot({ tosAccepted: true }), { type: 'IDENTITY_SUBMIT', values: VALID }],
    [
      boot({ tosAccepted: true }),
      { type: 'IDENTITY_SUBMIT', values: VALID },
      { type: 'RELAY_OK', bridgeCustomerId: 'c', status: 'approved' },
    ],
    [
      boot({ tosAccepted: true }),
      { type: 'IDENTITY_SUBMIT', values: VALID },
      { type: 'RELAY_ERROR', failure: { status: 422, code: 'validation_error', path: null } },
      { type: 'IDENTITY_SUBMIT', values: VALID },
      { type: 'RELAY_ERROR', failure: { status: 409, code: 'duplicate_identity', path: null } },
    ],
    [
      boot({ tosAccepted: true }),
      { type: 'IDENTITY_SUBMIT', values: { ...VALID, taxId: 'nope' } },
    ],
  ]

  const NEEDLES = [SSN, SSN_DIGITS, '1987-03-21', '1987', '078']

  it('no capture carries a DOB or a tax ID', () => {
    for (const events of paths) {
      const serialized = JSON.stringify(drive(events).captures)
      for (const needle of NEEDLES) {
        expect(serialized, `${needle} in ${serialized}`).not.toContain(needle)
      }
    }
  })

  it('no effect carries a DOB or a tax ID', () => {
    for (const events of paths) {
      const serialized = JSON.stringify(drive(events).effects)
      for (const needle of NEEDLES) {
        expect(serialized, `${needle} in ${serialized}`).not.toContain(needle)
      }
    }
  })

  it('the values exist in exactly one state — while the relay is in flight', () => {
    const { states } = drive([
      boot({ tosAccepted: true }),
      { type: 'IDENTITY_SUBMIT', values: VALID },
      { type: 'RELAY_OK', bridgeCustomerId: 'c', status: 'approved' },
    ])
    const holding = states.filter((s) => s.ctx.relayValues !== null)
    expect(holding).toHaveLength(1)
    expect(holding[0]!.view.step).toBe('relaying')
  })

  it('an invalid submit reports field names only, never a value', () => {
    const { state } = drive([
      boot({ tosAccepted: true }),
      { type: 'IDENTITY_SUBMIT', values: { ...VALID, taxId: SSN.slice(0, 4) } },
    ])
    expect(JSON.stringify(state.view)).not.toContain('078')
    expect(state.view).toEqual({ step: 'identity_form', reason: 'first', invalid: ['taxId'] })
  })
})
