import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// supabaseAdmin.from is the only external seam. A spy on every logger method
// backs the "payload never logged" assertions.
const from = vi.hoisted(() => vi.fn())
vi.mock('./supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}))

const { mapBridgeState, recordEvent, markProcessed, markIgnored, markFailed } = await import(
  './payment-events.js'
)

beforeEach(() => {
  from.mockReset()
})

// ── mapBridgeState ──────────────────────────────────────────────────────────

describe('mapBridgeState', () => {
  it('ignores states we are already past or that are transient (poller owns the alert)', () => {
    for (const state of ['awaiting_funds', 'funds_received', 'in_review']) {
      expect(mapBridgeState(state), state).toEqual({ kind: 'ignore' })
    }
  })

  it('maps payment_submitted to SUBMITTED → IN_FLIGHT with no ledger', () => {
    expect(mapBridgeState('payment_submitted')).toEqual({
      kind: 'transition',
      from: 'SUBMITTED',
      to: 'IN_FLIGHT',
    })
  })

  it('maps payment_processed to IN_FLIGHT → COMPLETED with the completed ledger flag', () => {
    expect(mapBridgeState('payment_processed')).toEqual({
      kind: 'transition',
      from: 'IN_FLIGHT',
      to: 'COMPLETED',
      ledger: 'completed',
    })
  })

  it('fails (no flags, no ledger) for undeliverable / error / canceled', () => {
    for (const state of ['undeliverable', 'error', 'canceled']) {
      expect(mapBridgeState(state), state).toEqual({ kind: 'fail', to: 'PAYOUT_FAILED' })
    }
  })

  it('flags bridgeReturns for returned / refunded / refund_in_flight', () => {
    for (const state of ['returned', 'refunded', 'refund_in_flight']) {
      expect(mapBridgeState(state), state).toEqual({
        kind: 'fail',
        to: 'PAYOUT_FAILED',
        bridgeReturns: true,
      })
    }
  })

  it('flags an ops alert for refund_failed (principal stuck)', () => {
    expect(mapBridgeState('refund_failed')).toEqual({
      kind: 'fail',
      to: 'PAYOUT_FAILED',
      alert: true,
    })
  })

  it('returns unknown for any unrecognized state — never crashes on a new Bridge state', () => {
    for (const state of ['', 'brand_new_bridge_state', 'PAYMENT_PROCESSED', 'refunded ', 'null']) {
      expect(mapBridgeState(state), state).toEqual({ kind: 'unknown' })
    }
  })
})

// ── recordEvent ─────────────────────────────────────────────────────────────

// from('payment_events').upsert(row, opts).select('id').maybeSingle()
function mockUpsert(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result)
  const select = vi.fn().mockReturnValue({ maybeSingle })
  const upsert = vi.fn().mockReturnValue({ select })
  return { upsert, select, maybeSingle }
}

// from('payment_events').select('id').eq(...).eq(...).maybeSingle()
function mockLookup(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result)
  const eq2 = vi.fn().mockReturnValue({ maybeSingle })
  const eq1 = vi.fn().mockReturnValue({ eq: eq2 })
  const select = vi.fn().mockReturnValue({ eq: eq1 })
  return { select, eq1, eq2, maybeSingle }
}

const input = {
  source: 'bridge' as const,
  externalEventId: 'evt_123',
  eventType: 'payment_submitted',
  transferId: 'tr-1',
  providerRef: 'bt_9',
  // A payload with a secret marker — no assertion may ever find this in a log.
  payload: { state: 'payment_submitted', secret: 'PII-DO-NOT-LOG' },
}

describe('recordEvent', () => {
  it('inserts a new event and reports inserted=true', async () => {
    const { upsert } = mockUpsert({ data: { id: 'pe-1' }, error: null })
    from.mockReturnValue({ upsert })

    const result = await recordEvent(input)

    expect(result).toEqual({ id: 'pe-1', inserted: true })
    expect(from).toHaveBeenCalledWith('payment_events')
    // status is left to the DB 'received' default — never set on insert.
    const [row, opts] = upsert.mock.calls[0] as [Record<string, unknown>, unknown]
    expect(row).toEqual({
      source: 'bridge',
      external_event_id: 'evt_123',
      event_type: 'payment_submitted',
      transfer_id: 'tr-1',
      provider_ref: 'bt_9',
      payload: input.payload,
    })
    expect('status' in row).toBe(false)
    expect(opts).toEqual({ onConflict: 'source,external_event_id', ignoreDuplicates: true })
  })

  it('reports inserted=false on a duplicate and returns the existing row id', async () => {
    // ignoreDuplicates → the conflicting row returns null; a follow-up select
    // fetches its id.
    const { upsert } = mockUpsert({ data: null, error: null })
    const lookup = mockLookup({ data: { id: 'pe-existing' }, error: null })
    from.mockReturnValueOnce({ upsert }).mockReturnValueOnce({ select: lookup.select })

    const result = await recordEvent(input)

    expect(result).toEqual({ id: 'pe-existing', inserted: false })
    expect(lookup.eq1).toHaveBeenCalledWith('source', 'bridge')
    expect(lookup.eq2).toHaveBeenCalledWith('external_event_id', 'evt_123')
  })

  it('defaults nullable transfer/provider refs to null', async () => {
    const { upsert } = mockUpsert({ data: { id: 'pe-2' }, error: null })
    from.mockReturnValue({ upsert })

    await recordEvent({
      source: 'bridge_poll',
      externalEventId: 'bt_9:payment_processed',
      eventType: 'payment_processed',
      payload: { state: 'payment_processed' },
    })

    const [row] = upsert.mock.calls[0] as [Record<string, unknown>]
    expect(row.transfer_id).toBeNull()
    expect(row.provider_ref).toBeNull()
  })

  it('throws when the upsert fails', async () => {
    const { upsert } = mockUpsert({ data: null, error: { message: 'boom' } })
    from.mockReturnValue({ upsert })

    await expect(recordEvent(input)).rejects.toThrow(/payment_events insert failed: boom/)
  })

  it('throws when the duplicate lookup fails', async () => {
    const { upsert } = mockUpsert({ data: null, error: null })
    const lookup = mockLookup({ data: null, error: { message: 'lookup boom' } })
    from.mockReturnValueOnce({ upsert }).mockReturnValueOnce({ select: lookup.select })

    await expect(recordEvent(input)).rejects.toThrow(/payment_events lookup failed: lookup boom/)
  })

  it('never passes the raw payload to any logger', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    )
    try {
      const { upsert } = mockUpsert({ data: { id: 'pe-1' }, error: null })
      from.mockReturnValue({ upsert })

      await recordEvent(input)

      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled()
      }
    } finally {
      spies.forEach((s) => s.mockRestore())
    }
  })
})

// ── mark helpers ────────────────────────────────────────────────────────────

// from('payment_events').update({...}).eq('id', id)
function mockUpdate(result: { error: unknown }) {
  const eq = vi.fn().mockResolvedValue(result)
  const update = vi.fn().mockReturnValue({ eq })
  return { update, eq }
}

describe('mark helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-21T09:00:00.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('markProcessed sets status processed + processed_at, clears error', async () => {
    const { update, eq } = mockUpdate({ error: null })
    from.mockReturnValue({ update })

    await markProcessed('pe-1')

    expect(from).toHaveBeenCalledWith('payment_events')
    expect(update).toHaveBeenCalledWith({
      status: 'processed',
      processed_at: '2026-07-21T09:00:00.000Z',
      error: null,
    })
    expect(eq).toHaveBeenCalledWith('id', 'pe-1')
  })

  it('markIgnored sets status ignored + processed_at + the reason', async () => {
    const { update } = mockUpdate({ error: null })
    from.mockReturnValue({ update })

    await markIgnored('pe-2', 'out_of_order')

    expect(update).toHaveBeenCalledWith({
      status: 'ignored',
      processed_at: '2026-07-21T09:00:00.000Z',
      error: 'out_of_order',
    })
  })

  it('markIgnored defaults the reason to null', async () => {
    const { update } = mockUpdate({ error: null })
    from.mockReturnValue({ update })

    await markIgnored('pe-2')

    expect(update).toHaveBeenCalledWith({
      status: 'ignored',
      processed_at: '2026-07-21T09:00:00.000Z',
      error: null,
    })
  })

  it('markFailed sets status failed + processed_at + the error', async () => {
    const { update } = mockUpdate({ error: null })
    from.mockReturnValue({ update })

    await markFailed('pe-3', 'transition_conflict')

    expect(update).toHaveBeenCalledWith({
      status: 'failed',
      processed_at: '2026-07-21T09:00:00.000Z',
      error: 'transition_conflict',
    })
  })

  it('throws when the update fails', async () => {
    const { update } = mockUpdate({ error: { message: 'db down' } })
    from.mockReturnValue({ update })

    await expect(markProcessed('pe-1')).rejects.toThrow(/mark processed failed: db down/)
  })
})
