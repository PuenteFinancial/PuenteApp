import { describe, it, expect } from 'vitest'
import {
  initialCryptoPayState,
  initialEffects,
  transition,
  buildAddressPatch,
  buildExchangeBody,
  buildCustomerBody,
  buildSessionCreateBody,
  buildCheckoutBody,
  buildKycInfo,
  buildRelayBody,
  relayValuesFrom,
  invalidKycFields,
  invalidIdentityFields,
  isPermanentRejection,
  addressEdited,
  classifyCryptoApiError,
  stepUpFormFor,
  parseLimits,
  kycOutcomeFor,
  kycTierFor,
  KYC_POLL_TIMEOUT_TICKS,
  BRIDGE_POLL_TIMEOUT_TICKS,
  type CryptoPayEvent,
  type CryptoPayState,
  type CryptoPrefill,
  type KycFormValues,
  type Transition,
} from './cryptoPayStep'

const TRANSFER_ID = 'aaaaaaaa-1111-4222-8333-444444444444'

/** Baseline: ToS already on file (the common returning case), no Bridge
 *  customer yet — the K6 relay path. */
const prefill: CryptoPrefill = {
  firstName: 'Test',
  lastName: 'User',
  email: 'test@example.com',
  phone: '+12125551234',
  addressLine1: '123 Main St',
  addressLine2: null,
  addressCity: 'Austin',
  addressState: 'TX',
  addressPostalCode: '78701',
  bridgeCustomerId: null,
  kycStatus: 'not_started',
  bridgeTosAccepted: true,
}

/** Brand-new sender: nothing on file at Bridge, no ToS. */
const noTos: CryptoPrefill = { ...prefill, bridgeTosAccepted: false }

/** Sandbox canonical values (John Verified / 000000000 / 1990-01-15). */
const values: KycFormValues = {
  firstName: 'Test',
  lastName: 'User',
  addressLine1: '123 Main St',
  addressLine2: '',
  city: 'Austin',
  state: 'TX',
  postalCode: '78701',
  dobMonth: '1',
  dobDay: '15',
  dobYear: '1990',
  taxId: '000-00-0000',
  taxIdType: 'ssn',
}

const RELAY_BODY = { dob: '1990-01-15', taxId: { type: 'ssn', number: '000000000' } }

const VERIFIED = [{ type: 'kyc_verified', status: 'verified' }]
const PENDING = [{ type: 'kyc_verified', status: 'pending' }]
const NOT_STARTED = [{ type: 'kyc_verified', status: 'not_started' }]
const REJECTED = [{ type: 'kyc_verified', status: 'rejected' }]

/** Fold events through the machine, collecting every effect and capture. */
function run(events: CryptoPayEvent[], from?: CryptoPayState) {
  let state = from ?? initialCryptoPayState(TRANSFER_ID)
  const effects: Transition['effects'] = []
  const captures: Transition['captures'] = []
  for (const event of events) {
    const t = transition(state, event)
    state = t.state
    effects.push(...t.effects)
    captures.push(...t.captures)
  }
  return { state, effects, captures }
}

const bootNew: CryptoPayEvent = { type: 'BOOT_OK', prefill, kyc: null }

/** intro → Link auth → exchange, for a given prefill and verification set. */
const throughExchange = (p: CryptoPrefill, verifications: { type: string; status: string }[]): CryptoPayEvent[] => [
  { type: 'BOOT_OK', prefill: p, kyc: null },
  { type: 'CONTINUE' },
  { type: 'INTENT_OK', authIntentId: 'lai_1', linkAccountExists: true },
  { type: 'AUTH_RESULT', result: 'success', cryptoCustomerId: 'crc_1' },
  { type: 'EXCHANGE_OK', verifications },
]

describe('boot routing (resume-at-right-step)', () => {
  it('starts the machine with a boot effect', () => {
    expect(initialEffects()).toEqual([{ kind: 'boot' }])
    expect(initialCryptoPayState(TRANSFER_ID).view).toEqual({ step: 'loading' })
    expect(initialCryptoPayState(TRANSFER_ID).ctx.relayValues).toBeNull()
  })

  it('no crypto customer → intro (full Link flow ahead)', () => {
    const { state } = run([bootNew])
    expect(state.view).toEqual({ step: 'intro' })
  })

  // A known crypto customer does NOT mean THIS browser's SDK is
  // authenticated — they are different credentials (drive finding
  // 2026-08-28: resuming past Link auth put an unauthenticated SDK in front
  // of collectPaymentMethod and 403'd). Every non-rejected boot re-enters
  // through intro → Link auth, which no-ops when the SDK is already good.
  it.each([
    ['not started', NOT_STARTED],
    ['pending', PENDING],
    ['verified', VERIFIED],
  ])('customer with %s identity still boots to intro (SDK auth is per-browser)', (_label, v) => {
    const { state, effects } = run([
      { type: 'BOOT_OK', prefill, kyc: { cryptoCustomerId: 'crc_1', verifications: v } },
    ])
    expect(state.view).toEqual({ step: 'intro' })
    expect(effects).toEqual([])
  })

  it('post-auth exchange: verified, no bridge customer, no values in hand (reload) → the two-field form', () => {
    const { state, captures } = run(throughExchange(prefill, VERIFIED))
    expect(state.view).toEqual({ step: 'relay_form', reason: 'reload', invalid: false })
    expect(captures.map((c) => c.event)).toContain('send_relay_form_viewed')
  })

  it('post-auth exchange routes a fully-ready user to collect', () => {
    const ready = { ...prefill, bridgeCustomerId: 'bc_1', kycStatus: 'approved' }
    const { state, effects } = run(throughExchange(ready, VERIFIED))
    expect(state.view).toEqual({ step: 'collect', notice: null })
    expect(effects.at(-1)).toEqual({ kind: 'sdk_collect' })
  })

  it('stripe KYC rejected at boot → terminal rejection', () => {
    const { state, captures } = run([
      { type: 'BOOT_OK', prefill, kyc: { cryptoCustomerId: 'crc_1', verifications: REJECTED } },
    ])
    expect(state.view).toEqual({ step: 'failed', kind: 'kyc_rejected' })
    expect(captures[0].event).toBe('send_kyc_rejected')
  })

  it('boot failure → retryable boot error, and RETRY reboots the machine', () => {
    const { state } = run([{ type: 'BOOT_FAILED' }])
    expect(state.view).toEqual({ step: 'boot_error' })
    const t = transition(state, { type: 'RETRY' })
    expect(t.state.view).toEqual({ step: 'loading' })
    expect(t.effects).toEqual([{ kind: 'boot' }])
  })
})

describe('ToS-first gate (K6 decision 1)', () => {
  it('a brand-new sender sees the Bridge ToS card BEFORE Link auth, with no intent minted', () => {
    const { state, effects, captures } = run([
      { type: 'BOOT_OK', prefill: noTos, kyc: null },
      { type: 'CONTINUE' },
    ])
    expect(state.view).toEqual({ step: 'bridge_tos' })
    expect(effects).toEqual([])
    expect(captures.map((c) => c.event)).toEqual(['send_bridge_tos_viewed'])
  })

  it('accepting hands off to the hosted click-through (the return leg reboots the machine)', () => {
    const at = run([{ type: 'BOOT_OK', prefill: noTos, kyc: null }, { type: 'CONTINUE' }]).state
    const t = transition(at, { type: 'BRIDGE_CONTINUE' })
    expect(t.state.view).toEqual({ step: 'bridge_tos' })
    expect(t.effects).toEqual([{ kind: 'bridge_redirect' }])
    expect(t.captures.map((c) => c.event)).toEqual(['send_bridge_tos_started'])
  })

  it('ToS on file → straight to Link auth', () => {
    const { state, effects } = run([bootNew, { type: 'CONTINUE' }])
    expect(state.view).toEqual({ step: 'link_auth' })
    expect(effects).toEqual([{ kind: 'create_intent' }])
  })

  it('a pre-K6 Bridge customer (accepted through the hosted flow) skips the gate too', () => {
    const legacy = { ...noTos, bridgeCustomerId: 'bc_legacy', kycStatus: 'approved' }
    const { state } = run([{ type: 'BOOT_OK', prefill: legacy, kyc: null }, { type: 'CONTINUE' }])
    expect(state.view).toEqual({ step: 'link_auth' })
  })

  it('BRIDGE_CONTINUE is ignored anywhere but the ToS card', () => {
    const polling = run(throughExchange({ ...prefill, bridgeCustomerId: 'bc_1', kycStatus: 'pending' }, VERIFIED)).state
    expect(polling.view).toEqual({ step: 'bridge_polling' })
    const t = transition(polling, { type: 'BRIDGE_CONTINUE' })
    expect(t.effects).toEqual([])
    expect(t.state.view).toEqual({ step: 'bridge_polling' })
  })
})

describe('Link auth', () => {
  it('happy path: continue → intent → authenticate → exchange → form', () => {
    const { state, effects, captures } = run(throughExchange(prefill, NOT_STARTED))
    expect(state.view).toEqual({ step: 'kyc_form', mode: 'l1', invalid: false, notice: null })
    expect(effects).toEqual([
      { kind: 'create_intent' },
      { kind: 'sdk_authenticate', authIntentId: 'lai_1' },
      { kind: 'exchange_and_customer', authIntentId: 'lai_1', cryptoCustomerId: 'crc_1' },
    ])
    expect(captures.map((c) => c.event)).toEqual([
      'send_link_auth_started',
      'send_link_authenticated',
      'send_crypto_customer_created',
      'send_kyc_form_viewed',
    ])
    for (const c of captures) expect(c.props.transfer_id).toBe(TRANSFER_ID)
  })

  it('no Link account → register, then a NEW intent', () => {
    const { state, effects, captures } = run([
      bootNew,
      { type: 'CONTINUE' },
      { type: 'INTENT_OK', authIntentId: '', linkAccountExists: false },
      { type: 'REGISTER_OK' },
    ])
    expect(state.view).toEqual({ step: 'link_auth' })
    expect(effects).toEqual([
      { kind: 'create_intent' },
      { kind: 'sdk_register' },
      { kind: 'create_intent' },
    ])
    expect(captures.map((c) => c.event)).toEqual(['send_link_auth_started', 'send_link_registered'])
  })

  it('register loop guard: a second linkAccountExists=false after registering fails, never loops', () => {
    const { state, captures } = run([
      bootNew,
      { type: 'CONTINUE' },
      { type: 'INTENT_OK', authIntentId: '', linkAccountExists: false },
      { type: 'REGISTER_OK' },
      { type: 'INTENT_OK', authIntentId: '', linkAccountExists: false },
    ])
    expect(state.view).toEqual({ step: 'failed', kind: 'retryable' })
    expect(captures.at(-1)).toMatchObject({
      event: 'send_link_auth_failed',
      props: { outcome: 'register_loop' },
    })
  })

  it('abandoned → soft card; resume mints a FRESH intent', () => {
    const { state, effects } = run([
      bootNew,
      { type: 'CONTINUE' },
      { type: 'INTENT_OK', authIntentId: 'lai_1', linkAccountExists: true },
      { type: 'AUTH_RESULT', result: 'abandoned' },
      { type: 'RESUME_LINK' },
    ])
    expect(state.view).toEqual({ step: 'link_auth' })
    expect(effects.filter((e) => e.kind === 'create_intent')).toHaveLength(2)
  })

  it('declined → terminal link_declined (consent is required)', () => {
    const { state, captures } = run([
      bootNew,
      { type: 'CONTINUE' },
      { type: 'INTENT_OK', authIntentId: 'lai_1', linkAccountExists: true },
      { type: 'AUTH_RESULT', result: 'declined' },
    ])
    expect(state.view).toEqual({ step: 'failed', kind: 'link_declined' })
    expect(captures.at(-1)).toMatchObject({ props: { outcome: 'declined' } })
  })

  it('exchange verified short-circuit: a returning verified user skips the form', () => {
    const ready = { ...prefill, bridgeCustomerId: 'bc_1', kycStatus: 'approved' }
    const { state } = run(throughExchange(ready, VERIFIED))
    expect(state.view).toEqual({ step: 'collect', notice: null })
  })
})

describe('KYC form and polling', () => {
  const atForm = () => run(throughExchange(prefill, NOT_STARTED)).state

  it('valid submit without address edit → sdk_submit_kyc, and the identity values wait in ctx', () => {
    const t = transition(atForm(), { type: 'KYC_SUBMIT', values, addressEdited: false })
    expect(t.state.view).toEqual({ step: 'kyc_submitting' })
    expect(t.effects).toEqual([{ kind: 'sdk_submit_kyc', values, mode: 'l1' }])
    expect(t.captures[0]).toMatchObject({
      event: 'send_kyc_submitted',
      props: { mode: 'l1', taxIdType: 'ssn' },
    })
    expect(t.state.ctx.relayValues).toEqual({ dob: '1990-01-15', taxIdType: 'ssn', taxId: '000000000' })
  })

  it('edited address → PATCH first (sync-back decision), then SDK submit', () => {
    const edited = { ...values, addressLine1: '456 Oak Ave' }
    const t1 = transition(atForm(), { type: 'KYC_SUBMIT', values: edited, addressEdited: true })
    expect(t1.state.view).toEqual({ step: 'kyc_address_sync' })
    expect(t1.effects).toEqual([
      { kind: 'patch_address', body: buildAddressPatch(prefill, edited) },
    ])
    const t2 = transition(t1.state, { type: 'ADDRESS_SYNCED', values: edited, mode: 'l1' })
    expect(t2.state.view).toEqual({ step: 'kyc_submitting' })
    expect(t2.effects).toEqual([{ kind: 'sdk_submit_kyc', values: edited, mode: 'l1' }])
    // The refreshed prefill means a re-render compares against stored truth.
    expect(t2.state.ctx.prefill?.addressLine1).toBe('456 Oak Ave')
  })

  it('invalid values never leave the form (and never reach the SDK or ctx)', () => {
    const bad = { ...values, taxId: '12' }
    const t = transition(atForm(), { type: 'KYC_SUBMIT', values: bad, addressEdited: false })
    expect(t.state.view).toEqual({ step: 'kyc_form', mode: 'l1', invalid: true, notice: null })
    expect(t.effects).toEqual([])
    expect(t.state.ctx.relayValues).toBeNull()
  })

  it('submit → poll → verified → relay (first-time flow)', () => {
    const t1 = transition(atForm(), { type: 'KYC_SUBMIT', values, addressEdited: false })
    const { state, effects, captures } = run(
      [{ type: 'KYC_SUBMITTED' }, { type: 'KYC_POLL_RESULT', verifications: VERIFIED }],
      t1.state,
    )
    expect(state.view).toEqual({ step: 'relaying' })
    expect(effects.at(-1)).toEqual({ kind: 'relay', body: RELAY_BODY })
    expect(captures.map((c) => c.event)).toEqual(['send_kyc_verified', 'send_bridge_relay_started'])
    expect(captures[0].props.tier).toBe('L1')
    expect(captures[1].props).toMatchObject({ taxIdType: 'ssn', reason: 'verified' })
  })

  it('an ITIN rides the SDK us_ssn field and the relay itin type', () => {
    const itin = { ...values, taxId: '912-34-5678', taxIdType: 'itin' as const }
    expect(buildKycInfo(itin, 'l1').id_number).toEqual({ type: 'us_ssn', value: '912345678' })
    const t1 = transition(atForm(), { type: 'KYC_SUBMIT', values: itin, addressEdited: false })
    expect(t1.captures[0].props.taxIdType).toBe('itin')
    const { effects } = run(
      [{ type: 'KYC_SUBMITTED' }, { type: 'KYC_POLL_RESULT', verifications: VERIFIED }],
      t1.state,
    )
    expect(effects.at(-1)).toEqual({
      kind: 'relay',
      body: { dob: '1990-01-15', taxId: { type: 'itin', number: '912345678' } },
    })
  })

  it('poll rejection → ONE correction (form with the rejected notice, values dropped), then terminal', () => {
    const t1 = transition(atForm(), { type: 'KYC_SUBMIT', values, addressEdited: false })
    const first = run(
      [{ type: 'KYC_SUBMITTED' }, { type: 'KYC_POLL_RESULT', verifications: REJECTED }],
      t1.state,
    )
    expect(first.state.view).toEqual({ step: 'kyc_form', mode: 'l1', invalid: false, notice: 'rejected' })
    expect(first.state.ctx.correctionUsed).toBe(true)
    expect(first.state.ctx.relayValues).toBeNull()
    expect(first.captures.map((c) => c.event)).toEqual(['send_kyc_correction_offered'])

    const second = run(
      [
        { type: 'KYC_SUBMIT', values, addressEdited: false },
        { type: 'KYC_SUBMITTED' },
        { type: 'KYC_POLL_RESULT', verifications: REJECTED },
      ],
      first.state,
    )
    expect(second.state.view).toEqual({ step: 'failed', kind: 'kyc_rejected' })
    expect(second.state.ctx.relayValues).toBeNull()
    expect(second.captures.at(-1)).toMatchObject({
      event: 'send_kyc_rejected',
      props: { code: 'verification_rejected' },
    })
  })

  it('a corrected submission that verifies still relays', () => {
    const t1 = transition(atForm(), { type: 'KYC_SUBMIT', values, addressEdited: false })
    const first = run(
      [{ type: 'KYC_SUBMITTED' }, { type: 'KYC_POLL_RESULT', verifications: REJECTED }],
      t1.state,
    )
    const { state, effects } = run(
      [
        { type: 'KYC_SUBMIT', values: { ...values, dobDay: '16' }, addressEdited: false },
        { type: 'KYC_SUBMITTED' },
        { type: 'KYC_POLL_RESULT', verifications: VERIFIED },
      ],
      first.state,
    )
    expect(state.view).toEqual({ step: 'relaying' })
    expect(effects.at(-1)).toEqual({
      kind: 'relay',
      body: { dob: '1990-01-16', taxId: { type: 'ssn', number: '000000000' } },
    })
  })

  it('a failed SDK submit drops the held values (the form re-enters them)', () => {
    const t1 = transition(atForm(), { type: 'KYC_SUBMIT', values, addressEdited: false })
    const t2 = transition(t1.state, { type: 'KYC_SUBMIT_FAILED' })
    expect(t2.state.view).toEqual({ step: 'kyc_form', mode: 'l1', invalid: true, notice: null })
    expect(t2.state.ctx.relayValues).toBeNull()
  })

  it('poll failures are tolerated, and the timeout flips the soft copy without stopping', () => {
    const t1 = transition(atForm(), { type: 'KYC_SUBMIT', values, addressEdited: false })
    let state = transition(t1.state, { type: 'KYC_SUBMITTED' }).state
    for (let i = 0; i < KYC_POLL_TIMEOUT_TICKS; i++) {
      const t = transition(state, { type: 'KYC_POLL_FAILED' })
      expect(t.effects).toEqual([{ kind: 'poll_kyc' }])
      state = t.state
    }
    expect(state.view).toEqual({ step: 'kyc_polling', timedOut: true })
    const retried = transition(state, { type: 'RETRY_POLL' })
    expect(retried.state.view).toEqual({ step: 'kyc_polling', timedOut: false })
  })
})

describe('the relay (K6)', () => {
  /** Parked at `relaying` with the values already POSTed. */
  const atRelaying = () => {
    const t1 = transition(run(throughExchange(prefill, NOT_STARTED)).state, {
      type: 'KYC_SUBMIT',
      values,
      addressEdited: false,
    })
    return run([{ type: 'KYC_SUBMITTED' }, { type: 'KYC_POLL_RESULT', verifications: VERIFIED }], t1.state)
      .state
  }

  it('RELAY_OK approved → collect; values gone, customer recorded, created capture fires once', () => {
    const t = transition(atRelaying(), { type: 'RELAY_OK', bridgeCustomerId: 'bc_new', status: 'approved' })
    expect(t.state.view).toEqual({ step: 'collect', notice: null })
    expect(t.effects).toEqual([{ kind: 'sdk_collect' }])
    expect(t.state.ctx.relayValues).toBeNull()
    expect(t.state.ctx.prefill).toMatchObject({ bridgeCustomerId: 'bc_new', kycStatus: 'approved' })
    expect(t.captures.map((c) => c.event)).toEqual([
      'send_bridge_customer_created',
      'send_bridge_kyc_approved',
    ])
  })

  it('RELAY_OK pending → bounded Bridge poll, and polling never re-fires the created capture', () => {
    const t = transition(atRelaying(), { type: 'RELAY_OK', bridgeCustomerId: 'bc_new', status: 'pending' })
    expect(t.state.view).toEqual({ step: 'bridge_polling' })
    expect(t.effects).toEqual([{ kind: 'poll_users_me' }])
    expect(t.state.ctx.pollCount).toBe(0)
    const p1 = transition(t.state, { type: 'USERS_ME_RESULT', bridgeCustomerId: 'bc_new', kycStatus: 'pending' })
    expect(p1.captures).toEqual([])
    const p2 = transition(p1.state, { type: 'USERS_ME_RESULT', bridgeCustomerId: 'bc_new', kycStatus: 'approved' })
    expect(p2.captures.map((c) => c.event)).toEqual(['send_bridge_kyc_approved'])
    expect(p2.state.view).toEqual({ step: 'collect', notice: null })
  })

  it('RELAY_OK rejected → fetch the reasons', () => {
    const t = transition(atRelaying(), { type: 'RELAY_OK', bridgeCustomerId: 'bc_new', status: 'rejected' })
    expect(t.state.view).toEqual({ step: 'bridge_rejection' })
    expect(t.effects).toEqual([{ kind: 'fetch_rejection' }])
  })

  it('409 duplicate_identity → terminal support route (decision 9)', () => {
    const t = transition(atRelaying(), {
      type: 'RELAY_ERROR',
      failure: { status: 409, code: 'duplicate_identity', issue: null, path: null },
    })
    expect(t.state.view).toEqual({ step: 'failed', kind: 'duplicate_identity' })
    expect(t.state.ctx.relayValues).toBeNull()
    expect(t.captures[0]).toMatchObject({
      event: 'send_bridge_relay_failed',
      props: { code: 'duplicate_identity' },
    })
  })

  it('422 provider_rejected → the two-field correction form, which relays again', () => {
    const t = transition(atRelaying(), {
      type: 'RELAY_ERROR',
      failure: { status: 422, code: 'provider_rejected', issue: null, path: null },
    })
    expect(t.state.view).toEqual({ step: 'relay_form', reason: 'correction', invalid: false })
    expect(t.state.ctx.relayValues).toBeNull()

    const bad = transition(t.state, {
      type: 'RELAY_FORM_SUBMIT',
      values: { dobMonth: '13', dobDay: '15', dobYear: '1990', taxId: '000000000', taxIdType: 'ssn' },
    })
    expect(bad.state.view).toEqual({ step: 'relay_form', reason: 'correction', invalid: true })
    expect(bad.effects).toEqual([])

    const ok = transition(t.state, {
      type: 'RELAY_FORM_SUBMIT',
      values: { dobMonth: '2', dobDay: '3', dobYear: '1990', taxId: '000-00-0000', taxIdType: 'ssn' },
    })
    expect(ok.state.view).toEqual({ step: 'relaying' })
    expect(ok.effects).toEqual([
      { kind: 'relay', body: { dob: '1990-02-03', taxId: { type: 'ssn', number: '000000000' } } },
    ])
    expect(ok.captures[0]).toMatchObject({
      event: 'send_bridge_relay_started',
      props: { reason: 'correction', taxIdType: 'ssn' },
    })
  })

  it.each([
    ['bridge_tos missing', 'bridge_tos'],
    ['agreement id consumed', 'signed_agreement_id'],
  ])('409 conflict (%s) → back through the ToS click-through', (_label, path) => {
    const t = transition(atRelaying(), {
      type: 'RELAY_ERROR',
      failure: { status: 409, code: 'conflict', issue: null, path },
    })
    expect(t.state.view).toEqual({ step: 'bridge_tos' })
    expect(t.state.ctx.relayValues).toBeNull()
    expect(t.captures.map((c) => c.event)).toEqual(['send_bridge_relay_failed', 'send_bridge_tos_viewed'])
    expect(t.captures[1].props.reason).toBe(path)
  })

  it('403 kyc_required → re-verify with Stripe (l1 form)', () => {
    const t = transition(atRelaying(), {
      type: 'RELAY_ERROR',
      failure: { status: 403, code: 'kyc_required', issue: null, path: null },
    })
    expect(t.state.view).toEqual({ step: 'kyc_form', mode: 'l1', invalid: false, notice: null })
    expect(t.state.ctx.relayValues).toBeNull()
  })

  it.each([
    [502, 'provider_unavailable'],
    [429, 'rate_limited'],
    [500, 'internal_error'],
    [0, null],
  ])('%s %s → retryable, values dropped', (status, code) => {
    const t = transition(atRelaying(), {
      type: 'RELAY_ERROR',
      failure: { status, code, issue: null, path: null },
    })
    expect(t.state.view).toEqual({ step: 'failed', kind: 'retryable' })
    expect(t.state.ctx.relayValues).toBeNull()
  })

  it('reload edge: verified with no customer and no values → the two-field form, then the relay', () => {
    const at = run(throughExchange(prefill, VERIFIED)).state
    expect(at.view).toEqual({ step: 'relay_form', reason: 'reload', invalid: false })
    const t = transition(at, {
      type: 'RELAY_FORM_SUBMIT',
      values: { dobMonth: '01', dobDay: '15', dobYear: '1990', taxId: '000000000', taxIdType: 'ssn' },
    })
    expect(t.state.view).toEqual({ step: 'relaying' })
    expect(t.effects).toEqual([{ kind: 'relay', body: RELAY_BODY }])
    expect(t.captures[0].props.reason).toBe('reload')
  })

  it('RELAY_OK / RELAY_ERROR are ignored unless a relay is in flight', () => {
    const at = run(throughExchange(prefill, VERIFIED)).state
    expect(transition(at, { type: 'RELAY_OK', bridgeCustomerId: 'x', status: 'approved' }).state).toBe(at)
    expect(
      transition(at, { type: 'RELAY_ERROR', failure: { status: 502, code: null, issue: null, path: null } })
        .state,
    ).toBe(at)
  })
})

describe('step-up re-entry', () => {
  /** State parked at collect with a verified identity and bridge done. */
  const atCollect = () => {
    const ready = { ...prefill, bridgeCustomerId: 'bc_1', kycStatus: 'approved' }
    return run(throughExchange(ready, VERIFIED)).state
  }

  const collected: CryptoPayEvent = {
    type: 'PM_COLLECTED',
    cryptoPaymentToken: 'cpt_1',
    methodType: 'card',
    cardFunding: 'debit',
    wallet: null,
  }

  /** collect → payment method → treasury wallet registered → session create. */
  const atSessionCreate = () => run([collected, { type: 'WALLET_READY' }], atCollect())

  it('registers the treasury wallet before the first session create', () => {
    // Stripe refuses a raw wallet_address on headless session create
    // (crypto_onramp_consumer_wallet_doesnt_exist, proven live 2026-08-29).
    const t = transition(atCollect(), collected)
    expect(t.state.view).toEqual({ step: 'session_create' })
    expect(t.effects).toEqual([{ kind: 'sdk_register_wallet' }])
    const ready = transition(t.state, { type: 'WALLET_READY' })
    expect(ready.effects).toEqual([
      { kind: 'create_session', body: { paymentTokenId: 'cpt_1' } },
    ])
    expect(ready.state.ctx.walletRegistered).toBe(true)
  })

  it('a wallet registration failure never claims a payment was attempted', () => {
    const t = transition(transition(atCollect(), collected).state, { type: 'WALLET_FAILED' })
    expect(t.state.view).toEqual({ step: 'failed', kind: 'retryable' })
    expect(t.captures[0]).toMatchObject({ props: { code: 'wallet_registration_failed' } })
  })

  it('session-create kyc_required(identity) → l1 form → verified resumes create with the SAME cpt_, and never relays', () => {
    const t1 = { state: atSessionCreate().state, effects: [], captures: [] }
    expect(t1.state.view).toEqual({ step: 'session_create' })
    const t2 = transition(t1.state, {
      type: 'SESSION_ERROR',
      failure: {
        status: 400,
        code: 'kyc_required',
        issue: 'crypto_onramp_missing_identity_verification',
        path: null,
      },
    })
    expect(t2.state.view).toEqual({ step: 'kyc_form', mode: 'l1', invalid: false, notice: null })
    const { state, effects } = run(
      [
        { type: 'KYC_SUBMIT', values, addressEdited: false },
        { type: 'KYC_SUBMITTED' },
        { type: 'KYC_POLL_RESULT', verifications: VERIFIED },
      ],
      t2.state,
    )
    expect(state.view).toEqual({ step: 'session_create' })
    expect(effects.at(-1)).toEqual({ kind: 'create_session', body: { paymentTokenId: 'cpt_1' } })
    // The customer already exists: the step-up's values are dropped, not relayed.
    expect(effects.find((e) => e.kind === 'relay')).toBeUndefined()
    expect(state.ctx.relayValues).toBeNull()
  })

  it('session-create kyc_required(minimum) → l0 form (no tax ID/DOB demanded)', () => {
    const t1 = atSessionCreate()
    const t2 = transition(t1.state, {
      type: 'SESSION_ERROR',
      failure: {
        status: 400,
        code: 'kyc_required',
        issue: 'crypto_onramp_missing_minimum_identity_verification',
        path: null,
      },
    })
    expect(t2.state.view).toEqual({ step: 'kyc_form', mode: 'l0', invalid: false, notice: null })
  })

  it('session-create kyc_required(document) → verifyDocuments → verified resumes create', () => {
    const t1 = atSessionCreate()
    const t2 = transition(t1.state, {
      type: 'SESSION_ERROR',
      failure: {
        status: 400,
        code: 'kyc_required',
        issue: 'crypto_onramp_missing_document_verification',
        path: null,
      },
    })
    expect(t2.state.view).toEqual({ step: 'kyc_docs', abandoned: false })
    expect(t2.effects).toEqual([{ kind: 'sdk_verify_documents' }])
    const { state, effects, captures } = run(
      [
        { type: 'DOCS_RESULT', result: 'success' },
        {
          type: 'KYC_POLL_RESULT',
          verifications: [
            { type: 'kyc_verified', status: 'verified' },
            { type: 'document_verified', status: 'verified' },
          ],
        },
      ],
      t2.state,
    )
    expect(state.view).toEqual({ step: 'session_create' })
    expect(effects.at(-1)).toEqual({ kind: 'create_session', body: { paymentTokenId: 'cpt_1' } })
    expect(captures.find((c) => c.event === 'send_kyc_verified')?.props.tier).toBe('L2')
  })

  it('abandoned docs re-offer the flow instead of hanging', () => {
    const t1 = atSessionCreate()
    const t2 = transition(t1.state, {
      type: 'SESSION_ERROR',
      failure: {
        status: 400,
        code: 'kyc_required',
        issue: 'crypto_onramp_missing_document_verification',
        path: null,
      },
    })
    const t3 = transition(t2.state, { type: 'DOCS_RESULT', result: 'abandoned' })
    expect(t3.state.view).toEqual({ step: 'kyc_docs', abandoned: true })
    const t4 = transition(t3.state, { type: 'START_DOCS' })
    expect(t4.effects).toEqual([{ kind: 'sdk_verify_documents' }])
  })

  it('checkout kyc_required resumes CHECKOUT with the same session', () => {
    const t1 = atSessionCreate()
    const t2 = transition(t1.state, { type: 'SESSION_OK', sessionId: 'cos_1' })
    expect(t2.state.view).toEqual({ step: 'checkout' })
    const t3 = transition(t2.state, {
      type: 'CHECKOUT_ERROR',
      failure: {
        status: 400,
        code: 'kyc_required',
        issue: 'crypto_onramp_missing_document_verification',
        path: null,
      },
    })
    const { state, effects } = run(
      [
        { type: 'DOCS_RESULT', result: 'success' },
        { type: 'KYC_POLL_RESULT', verifications: VERIFIED },
      ],
      t3.state,
    )
    expect(state.view).toEqual({ step: 'checkout' })
    expect(effects.at(-1)).toEqual({ kind: 'sdk_checkout', sessionId: 'cos_1' })
  })

  it('409 conflict → recollect with a FRESH token (never resume)', () => {
    const t1 = atSessionCreate()
    const t2 = transition(t1.state, {
      type: 'SESSION_ERROR',
      failure: { status: 409, code: 'conflict', issue: null, path: null },
    })
    expect(t2.state.view).toEqual({ step: 'collect', notice: 'restart' })
    expect(t2.state.ctx.paymentTokenId).toBeNull()
    expect(t2.state.ctx.sessionId).toBeNull()
    expect(t2.effects).toEqual([{ kind: 'sdk_collect' }])
    expect(t2.captures[0]).toMatchObject({ event: 'send_payment_failed', props: { code: 'conflict' } })
  })

  it('409 link_auth_required → back to Link auth, attempt discarded', () => {
    const t1 = atSessionCreate()
    const t2 = transition(t1.state, {
      type: 'SESSION_ERROR',
      failure: { status: 409, code: 'link_auth_required', issue: null, path: null },
    })
    expect(t2.state.view).toEqual({ step: 'link_auth' })
    expect(t2.state.ctx.paymentTokenId).toBeNull()
    expect(t2.effects).toEqual([{ kind: 'create_intent' }])
  })

  it('403 → terminal unsupported; 5xx → retryable', () => {
    const t1 = atSessionCreate()
    const unsupported = transition(t1.state, {
      type: 'SESSION_ERROR',
      failure: { status: 403, code: 'funding_unsupported', issue: null, path: null },
    })
    expect(unsupported.state.view).toEqual({ step: 'failed', kind: 'unsupported' })
    const flaky = transition(t1.state, {
      type: 'SESSION_ERROR',
      failure: { status: 502, code: 'provider_unavailable', issue: null, path: null },
    })
    expect(flaky.state.view).toEqual({ step: 'failed', kind: 'retryable' })
  })

  it('a failed collect re-enters Link auth once, then gives up honestly', () => {
    // The SDK's session is not our OAuth token and can lapse independently;
    // re-authenticating is the real remedy (drive finding 2026-08-28).
    const first = transition(atCollect(), { type: 'COLLECT_FAILED' })
    expect(first.state.view).toEqual({ step: 'link_auth' })
    expect(first.effects).toEqual([{ kind: 'create_intent' }])
    expect(first.state.ctx.sdkReauthed).toBe(true)

    const second = transition(first.state, { type: 'COLLECT_FAILED' })
    expect(second.state.view).toEqual({ step: 'failed', kind: 'retryable' })
    expect(second.captures[0]).toMatchObject({ props: { code: 'collect_failed' } })
  })

  it('checkout success → submitted, with the cross-rail capture', () => {
    const t1 = atSessionCreate()
    const t2 = transition(t1.state, { type: 'SESSION_OK', sessionId: 'cos_1' })
    const t3 = transition(t2.state, { type: 'CHECKOUT_OK', successful: true })
    expect(t3.state.view).toEqual({ step: 'submitted' })
    expect(t3.captures.map((c) => c.event)).toEqual(['send_payment_submitted'])
  })

  it('checkout unsuccessful-without-error → recollect, never claims a charge', () => {
    const t1 = atSessionCreate()
    const t2 = transition(t1.state, { type: 'SESSION_OK', sessionId: 'cos_1' })
    const t3 = transition(t2.state, { type: 'CHECKOUT_OK', successful: false })
    expect(t3.state.view).toEqual({ step: 'collect', notice: 'restart' })
  })
})

describe('Bridge polling, wait, rejection and the Persona fallback', () => {
  const atBridgePolling = () => {
    const returning = { ...prefill, bridgeCustomerId: 'bc_1', kycStatus: 'pending' }
    return run(throughExchange(returning, VERIFIED)).state
  }

  it('approved → collect with the approval capture', () => {
    const t = transition(atBridgePolling(), {
      type: 'USERS_ME_RESULT',
      bridgeCustomerId: 'bc_1',
      kycStatus: 'approved',
    })
    expect(t.state.view).toEqual({ step: 'collect', notice: null })
    expect(t.captures.map((c) => c.event)).toEqual(['send_bridge_kyc_approved'])
  })

  it('rejected → fetch the reasons before deciding', () => {
    const t = transition(atBridgePolling(), {
      type: 'USERS_ME_RESULT',
      bridgeCustomerId: 'bc_1',
      kycStatus: 'rejected',
    })
    expect(t.state.view).toEqual({ step: 'bridge_rejection' })
    expect(t.effects).toEqual([{ kind: 'fetch_rejection' }])
    expect(t.captures.map((c) => c.event)).toEqual(['send_bridge_kyc_rejected'])
  })

  it('a curable rejection with retries left → the Persona offer → hosted retry', () => {
    const rejected = transition(atBridgePolling(), {
      type: 'USERS_ME_RESULT',
      bridgeCustomerId: 'bc_1',
      kycStatus: 'rejected',
    }).state
    const t = transition(rejected, {
      type: 'REJECTION_RESULT',
      reasons: ['We could not verify your identity from the information provided'],
      retriesRemaining: 3,
    })
    expect(t.state.view).toEqual({ step: 'bridge_persona', retriesRemaining: 3 })
    expect(t.captures[0]).toMatchObject({ event: 'send_bridge_persona_offered', props: { retriesRemaining: 3 } })
    const started = transition(t.state, { type: 'START_PERSONA' })
    expect(started.effects).toEqual([{ kind: 'persona_retry' }])
    expect(started.captures.map((c) => c.event)).toEqual(['send_bridge_persona_started'])
    const failed = transition(started.state, { type: 'PERSONA_REDIRECT_FAILED' })
    expect(failed.state.view).toEqual({ step: 'failed', kind: 'retryable' })
  })

  it.each([
    ['a permanent reason', ['Sanctions screening match'], 3, 'permanent'],
    ['no retries left', ['Document unreadable'], 0, 'retries_exhausted'],
  ])('%s → terminal rejection', (_label, reasons, retriesRemaining, reason) => {
    const rejected = transition(atBridgePolling(), {
      type: 'USERS_ME_RESULT',
      bridgeCustomerId: 'bc_1',
      kycStatus: 'rejected',
    }).state
    const t = transition(rejected, { type: 'REJECTION_RESULT', reasons, retriesRemaining })
    expect(t.state.view).toEqual({ step: 'failed', kind: 'kyc_rejected' })
    expect(t.captures[0]).toMatchObject({
      event: 'send_kyc_rejected',
      props: { code: 'bridge_rejected', reason },
    })
  })

  it('unreadable rejection detail fails TOWARD the Persona offer (the server bounds retries)', () => {
    const rejected = transition(atBridgePolling(), {
      type: 'USERS_ME_RESULT',
      bridgeCustomerId: 'bc_1',
      kycStatus: 'rejected',
    }).state
    const t = transition(rejected, { type: 'REJECTION_FAILED' })
    expect(t.state.view).toEqual({ step: 'bridge_persona', retriesRemaining: null })
  })

  it('pending past the bound → the come-back-later card, and a recheck restarts the poll', () => {
    let state = atBridgePolling()
    for (let i = 0; i < BRIDGE_POLL_TIMEOUT_TICKS - 1; i++) {
      const t = transition(state, { type: 'USERS_ME_RESULT', bridgeCustomerId: 'bc_1', kycStatus: 'pending' })
      expect(t.state.view).toEqual({ step: 'bridge_polling' })
      expect(t.effects).toEqual([{ kind: 'poll_users_me' }])
      state = t.state
    }
    const last = transition(state, { type: 'USERS_ME_RESULT', bridgeCustomerId: 'bc_1', kycStatus: 'pending' })
    expect(last.state.view).toEqual({ step: 'bridge_wait' })
    expect(last.effects).toEqual([])
    expect(last.captures[0]).toMatchObject({ event: 'send_bridge_wait', props: { reason: 'timeout' } })

    const recheck = transition(last.state, { type: 'BRIDGE_RECHECK' })
    expect(recheck.state.view).toEqual({ step: 'bridge_polling' })
    expect(recheck.state.ctx.pollCount).toBe(0)
    expect(recheck.effects).toEqual([{ kind: 'poll_users_me' }])
  })

  it('manual_review → the come-back-later card at once', () => {
    const t = transition(atBridgePolling(), {
      type: 'USERS_ME_RESULT',
      bridgeCustomerId: 'bc_1',
      kycStatus: 'manual_review',
    })
    expect(t.state.view).toEqual({ step: 'bridge_wait' })
    expect(t.captures[0]).toMatchObject({ props: { reason: 'manual_review' } })
  })

  it('poll errors count toward the same bound', () => {
    let state = atBridgePolling()
    for (let i = 0; i < BRIDGE_POLL_TIMEOUT_TICKS - 1; i++) {
      const t = transition(state, { type: 'USERS_ME_FAILED' })
      expect(t.effects).toEqual([{ kind: 'poll_users_me' }])
      state = t.state
    }
    expect(transition(state, { type: 'USERS_ME_FAILED' }).state.view).toEqual({ step: 'bridge_wait' })
  })
})

describe('Tax ID/DOB guard — exactly two effects and one ctx field may carry them', () => {
  // Risk 8 of the rehaul plan: "a test must prove no such field exists in any
  // API schema". The API side is pinned in apps/api (schema-pii.test.ts);
  // this is the web half — part (f) of the K6 six-part invariant.
  //
  // Two patterns: the JSON KEYS the values travel under, and the VALUES
  // themselves (sandbox canonical). Captures may legitimately carry
  // `taxIdType: 'ssn'` (a cohort label, not a number), so the key pattern
  // matches quoted keys followed by a colon: `"taxIdType":` does not match
  // `"taxId":`, and the value `"ssn"}` does not match `"ssn":`.
  const PII_KEYS = /"(ssn|taxId|dob|dobMonth|dobDay|dobYear|id_number|date_of_birth|birth_date|number)":/
  const PII_VALUES = /000000000|000-00-0000|1990/
  const clean = (value: unknown) => {
    const s = JSON.stringify(value)
    expect(s).not.toMatch(PII_KEYS)
    expect(s).not.toMatch(PII_VALUES)
  }

  it('every API-bound builder is clean even when fed full KYC values', () => {
    for (const body of [
      buildAddressPatch(prefill, values),
      buildExchangeBody('lai_1'),
      buildCustomerBody('crc_1'),
      buildSessionCreateBody('cpt_1'),
      buildCheckoutBody('cos_1', 'us_bank_account'),
    ]) {
      clean(body)
    }
  })

  it('the two sanctioned builders DO carry them — proving the guard bites', () => {
    const sdk = JSON.stringify(buildKycInfo(values, 'l1'))
    expect(sdk).toMatch(PII_KEYS)
    expect(sdk).toMatch(PII_VALUES)
    const relay = JSON.stringify(buildRelayBody(relayValuesFrom(values)))
    expect(relay).toMatch(PII_KEYS)
    expect(relay).toMatch(PII_VALUES)
    expect(buildRelayBody(relayValuesFrom(values))).toEqual(RELAY_BODY)
  })

  it('the l0 form never asks for what the tier did not demand', () => {
    const info = buildKycInfo(values, 'l0')
    expect(info.id_number).toBeUndefined()
    expect(info.date_of_birth).toBeUndefined()
  })

  it('across the whole first-send path: exactly one relay effect carries them, nothing else does, and ctx is clean past relayValues', () => {
    const events: CryptoPayEvent[] = [
      { type: 'BOOT_OK', prefill: noTos, kyc: null },
      { type: 'CONTINUE' },
      { type: 'BRIDGE_CONTINUE' },
      // (return leg reboots; simulate the post-ToS boot)
      { type: 'BOOT_OK', prefill, kyc: { cryptoCustomerId: 'crc_1', verifications: NOT_STARTED } },
      { type: 'CONTINUE' },
      { type: 'INTENT_OK', authIntentId: 'lai_1', linkAccountExists: true },
      { type: 'AUTH_RESULT', result: 'success', cryptoCustomerId: 'crc_1' },
      { type: 'EXCHANGE_OK', verifications: NOT_STARTED },
      { type: 'KYC_SUBMIT', values, addressEdited: true },
      { type: 'ADDRESS_SYNCED', values, mode: 'l1' },
      { type: 'KYC_SUBMITTED' },
      { type: 'KYC_POLL_RESULT', verifications: PENDING },
      { type: 'KYC_POLL_RESULT', verifications: VERIFIED },
      { type: 'RELAY_OK', bridgeCustomerId: 'bc_new', status: 'pending' },
      { type: 'USERS_ME_RESULT', bridgeCustomerId: 'bc_new', kycStatus: 'pending' },
      { type: 'USERS_ME_RESULT', bridgeCustomerId: 'bc_new', kycStatus: 'approved' },
      { type: 'PM_COLLECTED', cryptoPaymentToken: 'cpt_1', methodType: 'card', cardFunding: 'debit', wallet: null },
      { type: 'WALLET_READY' },
      { type: 'SESSION_OK', sessionId: 'cos_1' },
      { type: 'CHECKOUT_OK', successful: true },
    ]
    let state = initialCryptoPayState(TRANSFER_ID)
    const relays: Transition['effects'] = []
    for (const event of events) {
      const t = transition(state, event)
      state = t.state
      for (const effect of t.effects) {
        if (effect.kind === 'sdk_submit_kyc') continue // client → SDK only
        if (effect.kind === 'relay') {
          relays.push(effect)
          continue
        }
        clean(effect)
      }
      for (const capture of t.captures) clean(capture)
      // The one field, and nothing else in ctx.
      clean({ ...state.ctx, relayValues: null })
      // View data never carries them either.
      clean(state.view)
    }
    expect(relays).toEqual([{ kind: 'relay', body: RELAY_BODY }])
    expect(state.view).toEqual({ step: 'submitted' })
    expect(state.ctx.relayValues).toBeNull()
  })

  it('relayValues is null after RELAY_OK, RELAY_ERROR, a Stripe rejection, and RETRY', () => {
    const atForm = run(throughExchange(prefill, NOT_STARTED)).state
    const held = run(
      [{ type: 'KYC_SUBMIT', values, addressEdited: false }, { type: 'KYC_SUBMITTED' }],
      atForm,
    ).state
    expect(held.ctx.relayValues).not.toBeNull()

    const relaying = transition(held, { type: 'KYC_POLL_RESULT', verifications: VERIFIED }).state
    expect(relaying.ctx.relayValues).not.toBeNull()
    expect(transition(relaying, { type: 'RELAY_OK', bridgeCustomerId: 'bc', status: 'pending' }).state.ctx.relayValues).toBeNull()
    expect(
      transition(relaying, { type: 'RELAY_ERROR', failure: { status: 502, code: null, issue: null, path: null } })
        .state.ctx.relayValues,
    ).toBeNull()
    expect(transition(held, { type: 'KYC_POLL_RESULT', verifications: REJECTED }).state.ctx.relayValues).toBeNull()

    const failed = transition(relaying, {
      type: 'RELAY_ERROR',
      failure: { status: 502, code: null, issue: null, path: null },
    }).state
    expect(transition(failed, { type: 'RETRY' }).state.ctx.relayValues).toBeNull()
  })
})

describe('helpers', () => {
  it('classifyCryptoApiError parses the envelope (issue AND path) and tolerates garbage', () => {
    expect(
      classifyCryptoApiError(400, {
        error: { code: 'kyc_required', details: [{ path: 'kyc', issue: 'x' }] },
      }),
    ).toEqual({ status: 400, code: 'kyc_required', issue: 'x', path: 'kyc' })
    expect(classifyCryptoApiError(502, 'not json')).toEqual({ status: 502, code: null, issue: null, path: null })
    expect(classifyCryptoApiError(409, { error: { code: 'conflict' } })).toEqual({
      status: 409,
      code: 'conflict',
      issue: null,
      path: null,
    })
    expect(
      classifyCryptoApiError(409, {
        error: { code: 'conflict', details: [{ path: 'signed_agreement_id', issue: 'consumed' }] },
      }),
    ).toMatchObject({ path: 'signed_agreement_id', issue: 'consumed' })
  })

  it('stepUpFormFor maps the three Stripe codes and nothing else', () => {
    expect(stepUpFormFor('crypto_onramp_missing_minimum_identity_verification')).toBe('l0')
    expect(stepUpFormFor('crypto_onramp_missing_identity_verification')).toBe('l1')
    expect(stepUpFormFor('crypto_onramp_missing_document_verification')).toBe('docs')
    expect(stepUpFormFor('crypto_onramp_disabled')).toBeNull()
    expect(stepUpFormFor(null)).toBeNull()
  })

  it('parseLimits refuses everything but a recognizable numeric max', () => {
    expect(parseLimits(null)).toBeNull()
    expect(parseLimits({})).toBeNull()
    expect(parseLimits({ limits: 'nope' })).toBeNull()
    expect(parseLimits({ limits: { something: 'else' } })).toBeNull()
    expect(parseLimits({ limits: { max_transaction_amount: '250' } })).toEqual({ maxUsd: 250 })
    expect(parseLimits({ limits: { transaction_maximum: 100 } })).toEqual({ maxUsd: 100 })
    expect(parseLimits({ limits: { max_transaction_amount: '-5' } })).toBeNull()
  })

  it('kycOutcomeFor / kycTierFor read the unpinned vocabulary defensively', () => {
    expect(kycOutcomeFor([])).toBe('not_started')
    expect(kycOutcomeFor([{ type: 'identity', status: 'approved' }])).toBe('verified')
    expect(kycOutcomeFor([{ type: 'kyc_verified', status: 'in_review' }])).toBe('pending')
    expect(kycOutcomeFor([{ type: 'document_verified', status: 'verified' }])).toBe('not_started')
    // The tier vocabulary the preview API answered with live (2026-08-28):
    // kyc_tiers[]-derived entries whose type is the bare tier name.
    expect(kycOutcomeFor([{ type: 'l1', status: 'verified' }])).toBe('verified')
    expect(kycOutcomeFor([{ type: 'l1', status: 'pending' }])).toBe('pending')
    expect(kycTierFor(VERIFIED)).toBe('L1')
    expect(
      kycTierFor([
        { type: 'kyc_verified', status: 'verified' },
        { type: 'document_verified', status: 'verified' },
      ]),
    ).toBe('L2')
  })

  it('addressEdited compares against the prefill, treating null as empty', () => {
    expect(addressEdited(prefill, values)).toBe(false)
    expect(addressEdited(prefill, { ...values, addressLine1: 'other' })).toBe(true)
    expect(addressEdited({ ...prefill, addressLine2: null }, { ...values, addressLine2: '' })).toBe(
      false,
    )
  })

  it('invalidKycFields: l0 skips the identity fields, l1 demands them', () => {
    const noPii = { ...values, taxId: '', dobMonth: '', dobDay: '', dobYear: '' }
    expect(invalidKycFields(noPii, 'l0')).toEqual([])
    expect(invalidKycFields(noPii, 'l1')).toEqual(['dobMonth', 'dobDay', 'dobYear', 'taxId'])
    expect(invalidKycFields({ ...values, state: 'Texas' }, 'l1')).toEqual(['state'])
    expect(invalidKycFields({ ...values, taxId: '000-00-0000' }, 'l1')).toEqual([])
  })

  it('invalidIdentityFields: an ITIN is nine digits starting with 9; an SSN is any nine digits', () => {
    const base = { dobMonth: '1', dobDay: '15', dobYear: '1990' }
    expect(invalidIdentityFields({ ...base, taxId: '000000000', taxIdType: 'ssn' })).toEqual([])
    expect(invalidIdentityFields({ ...base, taxId: '912-34-5678', taxIdType: 'itin' })).toEqual([])
    expect(invalidIdentityFields({ ...base, taxId: '812345678', taxIdType: 'itin' })).toEqual(['taxId'])
    expect(invalidIdentityFields({ ...base, taxId: '12345678', taxIdType: 'ssn' })).toEqual(['taxId'])
    expect(invalidIdentityFields({ ...base, dobMonth: '0', taxId: '000000000', taxIdType: 'ssn' })).toEqual([
      'dobMonth',
    ])
  })

  it('relayValuesFrom zero-pads the date and strips dashes', () => {
    expect(
      relayValuesFrom({ dobMonth: '3', dobDay: '7', dobYear: '1985', taxId: '912-34-5678', taxIdType: 'itin' }),
    ).toEqual({ dob: '1985-03-07', taxIdType: 'itin', taxId: '912345678' })
    expect(
      relayValuesFrom({ dobMonth: '12', dobDay: '31', dobYear: '2000', taxId: '000000000', taxIdType: 'ssn' }),
    ).toEqual({ dob: '2000-12-31', taxIdType: 'ssn', taxId: '000000000' })
  })

  it('isPermanentRejection: denylist only — an unknown reason fails toward the Persona offer', () => {
    expect(isPermanentRejection(['Sanctions screening match'])).toBe(true)
    expect(isPermanentRejection(['Politically exposed person'])).toBe(true)
    expect(isPermanentRejection(['Suspected fraud'])).toBe(true)
    expect(isPermanentRejection(['Applicant is underage'])).toBe(true)
    expect(isPermanentRejection(['Could not verify identity from database lookup'])).toBe(false)
    expect(isPermanentRejection(['A peppy but unreadable document'])).toBe(false)
    expect(isPermanentRejection([])).toBe(false)
  })

  it('buildAddressPatch omits an empty line2 (all-or-none group, line2 optional)', () => {
    const body = buildAddressPatch(prefill, values)
    expect(body).toEqual({
      firstName: 'Test',
      lastName: 'User',
      email: 'test@example.com',
      addressLine1: '123 Main St',
      addressCity: 'Austin',
      addressState: 'TX',
      addressPostalCode: '78701',
    })
  })
})
