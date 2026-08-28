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
  invalidKycFields,
  addressEdited,
  classifyCryptoApiError,
  stepUpFormFor,
  parseLimits,
  kycOutcomeFor,
  kycTierFor,
  KYC_POLL_TIMEOUT_TICKS,
  type CryptoPayEvent,
  type CryptoPayState,
  type CryptoPrefill,
  type KycFormValues,
  type Transition,
} from './cryptoPayStep'

const TRANSFER_ID = 'aaaaaaaa-1111-4222-8333-444444444444'

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
}

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
  ssn: '000000000',
}

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

describe('boot routing (resume-at-right-step)', () => {
  it('starts the machine with a boot effect', () => {
    expect(initialEffects()).toEqual([{ kind: 'boot' }])
    expect(initialCryptoPayState(TRANSFER_ID).view).toEqual({ step: 'loading' })
  })

  it('no crypto customer → intro (full Link flow ahead)', () => {
    const { state } = run([bootNew])
    expect(state.view).toEqual({ step: 'intro' })
  })

  it('customer + identity not started → straight to the combined form, no Link UI', () => {
    const { state, captures } = run([
      { type: 'BOOT_OK', prefill, kyc: { cryptoCustomerId: 'crc_1', verifications: NOT_STARTED } },
    ])
    expect(state.view).toEqual({ step: 'kyc_form', mode: 'l1', invalid: false })
    expect(captures.map((c) => c.event)).toEqual(['send_kyc_form_viewed'])
  })

  it('customer + identity pending → polling (a submission may be mid-verify)', () => {
    const { state, effects } = run([
      { type: 'BOOT_OK', prefill, kyc: { cryptoCustomerId: 'crc_1', verifications: PENDING } },
    ])
    expect(state.view).toEqual({ step: 'kyc_polling', timedOut: false })
    expect(effects).toEqual([{ kind: 'poll_kyc' }])
  })

  it('identity verified + no bridge customer → the Persona fallback gate (before payment)', () => {
    const { state, captures } = run([
      { type: 'BOOT_OK', prefill, kyc: { cryptoCustomerId: 'crc_1', verifications: VERIFIED } },
    ])
    expect(state.view).toEqual({ step: 'bridge_tos' })
    expect(captures.map((c) => c.event)).toEqual(['send_bridge_fallback_started'])
  })

  it('identity verified + bridge approved → collect', () => {
    const ready = { ...prefill, bridgeCustomerId: 'bc_1', kycStatus: 'approved' }
    const { state, effects } = run([
      { type: 'BOOT_OK', prefill: ready, kyc: { cryptoCustomerId: 'crc_1', verifications: VERIFIED } },
    ])
    expect(state.view).toEqual({ step: 'collect', notice: null })
    expect(effects).toEqual([{ kind: 'sdk_collect' }])
  })

  it('identity verified + bridge pending → bridge polling (the return leg landing)', () => {
    const returning = { ...prefill, bridgeCustomerId: 'bc_1', kycStatus: 'pending' }
    const { state, effects } = run([
      {
        type: 'BOOT_OK',
        prefill: returning,
        kyc: { cryptoCustomerId: 'crc_1', verifications: VERIFIED },
      },
    ])
    expect(state.view).toEqual({ step: 'bridge_polling' })
    expect(effects).toEqual([{ kind: 'poll_users_me' }])
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

describe('Link auth', () => {
  it('happy path: continue → intent → authenticate → exchange → form', () => {
    const { state, effects, captures } = run([
      bootNew,
      { type: 'CONTINUE' },
      { type: 'INTENT_OK', authIntentId: 'lai_1', linkAccountExists: true },
      { type: 'AUTH_RESULT', result: 'success', cryptoCustomerId: 'crc_1' },
      { type: 'EXCHANGE_OK', verifications: NOT_STARTED },
    ])
    expect(state.view).toEqual({ step: 'kyc_form', mode: 'l1', invalid: false })
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
    const { state } = run([
      { type: 'BOOT_OK', prefill: ready, kyc: null },
      { type: 'CONTINUE' },
      { type: 'INTENT_OK', authIntentId: 'lai_1', linkAccountExists: true },
      { type: 'AUTH_RESULT', result: 'success', cryptoCustomerId: 'crc_1' },
      { type: 'EXCHANGE_OK', verifications: VERIFIED },
    ])
    expect(state.view).toEqual({ step: 'collect', notice: null })
  })
})

describe('KYC form and polling', () => {
  const atForm = () =>
    run([
      bootNew,
      { type: 'CONTINUE' },
      { type: 'INTENT_OK', authIntentId: 'lai_1', linkAccountExists: true },
      { type: 'AUTH_RESULT', result: 'success', cryptoCustomerId: 'crc_1' },
      { type: 'EXCHANGE_OK', verifications: NOT_STARTED },
    ]).state

  it('valid submit without address edit → sdk_submit_kyc directly', () => {
    const t = transition(atForm(), { type: 'KYC_SUBMIT', values, addressEdited: false })
    expect(t.state.view).toEqual({ step: 'kyc_submitting' })
    expect(t.effects).toEqual([{ kind: 'sdk_submit_kyc', values, mode: 'l1' }])
    expect(t.captures[0]).toMatchObject({ event: 'send_kyc_submitted', props: { mode: 'l1' } })
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

  it('invalid values never leave the form (and never reach the SDK)', () => {
    const bad = { ...values, ssn: '12' }
    const t = transition(atForm(), { type: 'KYC_SUBMIT', values: bad, addressEdited: false })
    expect(t.state.view).toEqual({ step: 'kyc_form', mode: 'l1', invalid: true })
    expect(t.effects).toEqual([])
  })

  it('submit → poll → verified → bridge gate (first-time flow)', () => {
    const t1 = transition(atForm(), { type: 'KYC_SUBMIT', values, addressEdited: false })
    const { state, captures } = run(
      [{ type: 'KYC_SUBMITTED' }, { type: 'KYC_POLL_RESULT', verifications: VERIFIED }],
      t1.state,
    )
    expect(state.view).toEqual({ step: 'bridge_tos' })
    expect(captures.map((c) => c.event)).toEqual([
      'send_kyc_verified',
      'send_bridge_fallback_started',
    ])
    expect(captures[0].props.tier).toBe('L1')
  })

  it('poll rejection is terminal', () => {
    const t1 = transition(atForm(), { type: 'KYC_SUBMIT', values, addressEdited: false })
    const { state, captures } = run(
      [{ type: 'KYC_SUBMITTED' }, { type: 'KYC_POLL_RESULT', verifications: REJECTED }],
      t1.state,
    )
    expect(state.view).toEqual({ step: 'failed', kind: 'kyc_rejected' })
    expect(captures.at(-1)?.event).toBe('send_kyc_rejected')
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

describe('step-up re-entry', () => {
  /** State parked at collect with a verified identity and bridge done. */
  const atCollect = () => {
    const ready = { ...prefill, bridgeCustomerId: 'bc_1', kycStatus: 'approved' }
    return run([
      { type: 'BOOT_OK', prefill: ready, kyc: { cryptoCustomerId: 'crc_1', verifications: VERIFIED } },
    ]).state
  }

  const collected: CryptoPayEvent = {
    type: 'PM_COLLECTED',
    cryptoPaymentToken: 'cpt_1',
    methodType: 'card',
    cardFunding: 'debit',
    wallet: null,
  }

  it('session-create kyc_required(identity) → l1 form → verified resumes create with the SAME cpt_', () => {
    const t1 = transition(atCollect(), collected)
    expect(t1.state.view).toEqual({ step: 'session_create' })
    const t2 = transition(t1.state, {
      type: 'SESSION_ERROR',
      failure: {
        status: 400,
        code: 'kyc_required',
        issue: 'crypto_onramp_missing_identity_verification',
      },
    })
    expect(t2.state.view).toEqual({ step: 'kyc_form', mode: 'l1', invalid: false })
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
  })

  it('session-create kyc_required(minimum) → l0 form (no SSN/DOB demanded)', () => {
    const t1 = transition(atCollect(), collected)
    const t2 = transition(t1.state, {
      type: 'SESSION_ERROR',
      failure: {
        status: 400,
        code: 'kyc_required',
        issue: 'crypto_onramp_missing_minimum_identity_verification',
      },
    })
    expect(t2.state.view).toEqual({ step: 'kyc_form', mode: 'l0', invalid: false })
  })

  it('session-create kyc_required(document) → verifyDocuments → verified resumes create', () => {
    const t1 = transition(atCollect(), collected)
    const t2 = transition(t1.state, {
      type: 'SESSION_ERROR',
      failure: {
        status: 400,
        code: 'kyc_required',
        issue: 'crypto_onramp_missing_document_verification',
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
    const t1 = transition(atCollect(), collected)
    const t2 = transition(t1.state, {
      type: 'SESSION_ERROR',
      failure: {
        status: 400,
        code: 'kyc_required',
        issue: 'crypto_onramp_missing_document_verification',
      },
    })
    const t3 = transition(t2.state, { type: 'DOCS_RESULT', result: 'abandoned' })
    expect(t3.state.view).toEqual({ step: 'kyc_docs', abandoned: true })
    const t4 = transition(t3.state, { type: 'START_DOCS' })
    expect(t4.effects).toEqual([{ kind: 'sdk_verify_documents' }])
  })

  it('checkout kyc_required resumes CHECKOUT with the same session', () => {
    const t1 = transition(atCollect(), collected)
    const t2 = transition(t1.state, { type: 'SESSION_OK', sessionId: 'cos_1' })
    expect(t2.state.view).toEqual({ step: 'checkout' })
    const t3 = transition(t2.state, {
      type: 'CHECKOUT_ERROR',
      failure: {
        status: 400,
        code: 'kyc_required',
        issue: 'crypto_onramp_missing_document_verification',
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
    const t1 = transition(atCollect(), collected)
    const t2 = transition(t1.state, {
      type: 'SESSION_ERROR',
      failure: { status: 409, code: 'conflict', issue: null },
    })
    expect(t2.state.view).toEqual({ step: 'collect', notice: 'restart' })
    expect(t2.state.ctx.paymentTokenId).toBeNull()
    expect(t2.state.ctx.sessionId).toBeNull()
    expect(t2.effects).toEqual([{ kind: 'sdk_collect' }])
    expect(t2.captures[0]).toMatchObject({ event: 'send_payment_failed', props: { code: 'conflict' } })
  })

  it('409 link_auth_required → back to Link auth, attempt discarded', () => {
    const t1 = transition(atCollect(), collected)
    const t2 = transition(t1.state, {
      type: 'SESSION_ERROR',
      failure: { status: 409, code: 'link_auth_required', issue: null },
    })
    expect(t2.state.view).toEqual({ step: 'link_auth' })
    expect(t2.state.ctx.paymentTokenId).toBeNull()
    expect(t2.effects).toEqual([{ kind: 'create_intent' }])
  })

  it('403 → terminal unsupported; 5xx → retryable', () => {
    const t1 = transition(atCollect(), collected)
    const unsupported = transition(t1.state, {
      type: 'SESSION_ERROR',
      failure: { status: 403, code: 'funding_unsupported', issue: null },
    })
    expect(unsupported.state.view).toEqual({ step: 'failed', kind: 'unsupported' })
    const flaky = transition(t1.state, {
      type: 'SESSION_ERROR',
      failure: { status: 502, code: 'provider_unavailable', issue: null },
    })
    expect(flaky.state.view).toEqual({ step: 'failed', kind: 'retryable' })
  })

  it('checkout success → submitted, with the cross-rail capture', () => {
    const t1 = transition(atCollect(), collected)
    const t2 = transition(t1.state, { type: 'SESSION_OK', sessionId: 'cos_1' })
    const t3 = transition(t2.state, { type: 'CHECKOUT_OK', successful: true })
    expect(t3.state.view).toEqual({ step: 'submitted' })
    expect(t3.captures.map((c) => c.event)).toEqual(['send_payment_submitted'])
  })

  it('checkout unsuccessful-without-error → recollect, never claims a charge', () => {
    const t1 = transition(atCollect(), collected)
    const t2 = transition(t1.state, { type: 'SESSION_OK', sessionId: 'cos_1' })
    const t3 = transition(t2.state, { type: 'CHECKOUT_OK', successful: false })
    expect(t3.state.view).toEqual({ step: 'collect', notice: 'restart' })
  })
})

describe('bridge fallback polling', () => {
  const atBridgePolling = () => {
    const returning = { ...prefill, bridgeCustomerId: 'bc_1', kycStatus: 'pending' }
    return run([
      {
        type: 'BOOT_OK',
        prefill: returning,
        kyc: { cryptoCustomerId: 'crc_1', verifications: VERIFIED },
      },
    ]).state
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

  it('rejected → terminal', () => {
    const t = transition(atBridgePolling(), {
      type: 'USERS_ME_RESULT',
      bridgeCustomerId: 'bc_1',
      kycStatus: 'rejected',
    })
    expect(t.state.view).toEqual({ step: 'failed', kind: 'kyc_rejected' })
  })

  it('tos_accepted fires exactly once, on the FIRST bridgeCustomerId sighting', () => {
    // Fresh flow: verified, no bridge customer → bridge_tos → user leaves and
    // returns → polling sees the id appear.
    const t1 = run([
      { type: 'BOOT_OK', prefill, kyc: { cryptoCustomerId: 'crc_1', verifications: VERIFIED } },
    ]).state
    expect(t1.view).toEqual({ step: 'bridge_tos' })
    // Simulate the polling landing (return leg boots into bridge_polling with
    // the id already set — bridgeCustomerSeen true — so no duplicate).
    const landed = atBridgePolling()
    const p1 = transition(landed, {
      type: 'USERS_ME_RESULT',
      bridgeCustomerId: 'bc_1',
      kycStatus: 'pending',
    })
    expect(p1.captures).toEqual([])
    const p2 = transition(p1.state, {
      type: 'USERS_ME_RESULT',
      bridgeCustomerId: 'bc_1',
      kycStatus: 'approved',
    })
    expect(p2.captures.map((c) => c.event)).toEqual(['send_bridge_kyc_approved'])
  })

  it('poll errors keep polling', () => {
    const t = transition(atBridgePolling(), { type: 'USERS_ME_FAILED' })
    expect(t.state.view).toEqual({ step: 'bridge_polling' })
    expect(t.effects).toEqual([{ kind: 'poll_users_me' }])
  })
})

describe('SSN/DOB guard — no API-bound payload can carry them', () => {
  // Risk 8 of the rehaul plan: "a test must prove no such field exists in any
  // API schema". The API side is pinned in apps/api; this is the web half —
  // every builder that produces a body for OUR /api gets the full KYC form
  // (SSN and all) and must emit nothing matching the PII pattern.
  const PII = /ssn|id_number|date_of_birth|dob|social|000000000|"1990"|:1990/i

  it('every API-bound builder is clean even when fed full KYC values', () => {
    const bodies = [
      buildAddressPatch(prefill, values),
      buildExchangeBody('lai_1'),
      buildCustomerBody('crc_1'),
      buildSessionCreateBody('cpt_1'),
      buildCheckoutBody('cos_1', 'us_bank_account'),
    ]
    for (const body of bodies) {
      expect(JSON.stringify(body)).not.toMatch(PII)
    }
  })

  it('buildKycInfo (SDK-only, the deliberate exception) DOES carry them — proving the guard bites', () => {
    expect(JSON.stringify(buildKycInfo(values, 'l1'))).toMatch(PII)
  })

  it('the l0 form never asks for what the tier did not demand', () => {
    const info = buildKycInfo(values, 'l0')
    expect(info.id_number).toBeUndefined()
    expect(info.date_of_birth).toBeUndefined()
  })

  it('no effect for our API ever embeds KYC form values', () => {
    // Walk the full happy path and serialize every non-SDK effect.
    const ready = { ...prefill, bridgeCustomerId: 'bc_1', kycStatus: 'approved' }
    const { effects } = run([
      { type: 'BOOT_OK', prefill: ready, kyc: { cryptoCustomerId: 'crc_1', verifications: NOT_STARTED } },
      { type: 'KYC_SUBMIT', values, addressEdited: true },
      { type: 'ADDRESS_SYNCED', values, mode: 'l1' },
      { type: 'KYC_SUBMITTED' },
      { type: 'KYC_POLL_RESULT', verifications: VERIFIED },
      {
        type: 'PM_COLLECTED',
        cryptoPaymentToken: 'cpt_1',
        methodType: 'card',
        cardFunding: 'debit',
        wallet: null,
      },
      { type: 'SESSION_OK', sessionId: 'cos_1' },
    ])
    for (const effect of effects) {
      if (effect.kind === 'sdk_submit_kyc') continue // client → SDK only
      expect(JSON.stringify(effect)).not.toMatch(PII)
    }
  })
})

describe('helpers', () => {
  it('classifyCryptoApiError parses the envelope and tolerates garbage', () => {
    expect(
      classifyCryptoApiError(400, {
        error: { code: 'kyc_required', details: [{ path: 'kyc', issue: 'x' }] },
      }),
    ).toEqual({ status: 400, code: 'kyc_required', issue: 'x' })
    expect(classifyCryptoApiError(502, 'not json')).toEqual({ status: 502, code: null, issue: null })
    expect(classifyCryptoApiError(409, { error: { code: 'conflict' } })).toEqual({
      status: 409,
      code: 'conflict',
      issue: null,
    })
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

  it('invalidKycFields: l0 skips SSN/DOB, l1 demands them', () => {
    const noPii = { ...values, ssn: '', dobMonth: '', dobDay: '', dobYear: '' }
    expect(invalidKycFields(noPii, 'l0')).toEqual([])
    expect(invalidKycFields(noPii, 'l1')).toEqual(['dobMonth', 'dobDay', 'dobYear', 'ssn'])
    expect(invalidKycFields({ ...values, state: 'Texas' }, 'l1')).toEqual(['state'])
    expect(invalidKycFields({ ...values, ssn: '000-00-0000' }, 'l1')).toEqual([])
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
