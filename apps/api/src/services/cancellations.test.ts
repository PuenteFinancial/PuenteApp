import { describe, it, expect, beforeEach, vi } from 'vitest'

// The cancellation-request record (slice-7 PR6b): the wrapper around
// record_cancellation_request plus the pending-lookup and resolve paths that
// every tail depends on. Harness mirrors refunds.test.ts: hoisted spies,
// per-table result queues, builder-id filter recording, dynamic import after
// the mocks are in place. The RPC's own semantics (atomicity, within_window,
// the partial unique index) are proven in cancellations.db.test.ts — what
// belongs here is the wrapper contract: exact params out, fail-closed on every
// ambiguous result, and resolve's guard filters.

const from = vi.hoisted(() => vi.fn())
const rpc = vi.hoisted(() => vi.fn())
vi.mock('./supabase.js', () => ({
  supabaseAdmin: {
    from: (...a: unknown[]) => from(...a),
    rpc: (...a: unknown[]) => rpc(...a),
  },
}))

const { recordCancellationRequest, pendingCancellationFor, resolveCancellationRequest } =
  await import('./cancellations.js')

// ── PostgREST-ish builder: from() dispenses results per table in call order,
// every filter method is recorded so the filters themselves can be asserted.
const queues: Record<string, unknown[]> = {}
const filters: Array<{ table: string; method: string; args: unknown[]; builder: number }> = []

function q(table: string, ...results: unknown[]): void {
  queues[table] = (queues[table] ?? []).concat(results)
}

// Each from() gets its own builder id so a filter can be attributed to the
// query that made it — resolve's `eq status pending` guard must be proven on
// the UPDATE builder itself, not inferred from an `eq` recorded anywhere.
let builderId = 0

function chain(table: string, result: unknown): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  const id = ++builderId
  for (const m of ['select', 'eq', 'is', 'not', 'in', 'or', 'lt', 'limit', 'update']) {
    c[m] = (...args: unknown[]) => {
      filters.push({ table, method: m, args, builder: id })
      return c
    }
  }
  c.maybeSingle = () => Promise.resolve(result)
  // the resolve update awaits the builder directly
  c.then = (resolve: (v: unknown) => void) => resolve(result)
  return c
}

const T = '00000000-0000-4000-8000-0000000000b1'
const U = '00000000-0000-4000-8000-0000000000b2'

// What the RPC returns: the full row, pending, with the frozen timeliness fact.
const requestRow = (over: Record<string, unknown> = {}) => ({
  id: 'cr-1',
  transfer_id: T,
  user_id: U,
  requested_at: '2026-07-28T09:00:00.000Z',
  requested_state: 'SUBMITTED',
  within_window: true,
  status: 'pending',
  resolution: null,
  resolved_at: null,
  resolved_by: null,
  created_at: '2026-07-28T09:00:00.000Z',
  updated_at: '2026-07-28T09:00:00.000Z',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(queues)) delete queues[k]
  filters.length = 0
  rpc.mockResolvedValue({ data: requestRow(), error: null })
  from.mockImplementation((table: string) =>
    chain(table, queues[table]?.shift() ?? { data: null, error: null }),
  )
})

describe('recordCancellationRequest', () => {
  it('calls the RPC with exactly the three params and returns the row', async () => {
    await expect(
      recordCancellationRequest({ transferId: T, userId: U, state: 'SUBMITTED' }),
    ).resolves.toMatchObject({ id: 'cr-1', within_window: true, requested_at: '2026-07-28T09:00:00.000Z' })

    // Exact params: the RPC computes within_window and requested_at ITSELF —
    // a caller-supplied timestamp or window flag here would be a second source
    // of truth for the statutory clock.
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('record_cancellation_request', {
      p_transfer_id: T,
      p_user_id: U,
      p_state: 'SUBMITTED',
    })
  })

  it('unwraps an array-shaped RPC result (PostgREST returns SETOF as an array)', async () => {
    rpc.mockResolvedValue({ data: [requestRow({ id: 'cr-2' })], error: null })

    await expect(
      recordCancellationRequest({ transferId: T, userId: U, state: 'IN_FLIGHT' }),
    ).resolves.toMatchObject({ id: 'cr-2' })
  })

  it('throws on an RPC error — the route decides whether to swallow, not this wrapper', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'transfer_not_found' } })

    await expect(
      recordCancellationRequest({ transferId: T, userId: U, state: 'FUNDED' }),
    ).rejects.toThrow(/record_cancellation_request failed: transfer_not_found/)
  })

  it('fails closed on a no-row result — never hands the caller undefined-as-recorded', async () => {
    // The route swallows this throw loudly (202 + Sentry). If the wrapper
    // returned undefined instead, the route would read `request.requested_at`
    // off it, throw inside its OWN catch… or worse, report recorded=true.
    rpc.mockResolvedValue({ data: null, error: null })

    await expect(
      recordCancellationRequest({ transferId: T, userId: U, state: 'SUBMITTED' }),
    ).rejects.toThrow(/no row returned/)

    rpc.mockResolvedValue({ data: [], error: null })
    await expect(
      recordCancellationRequest({ transferId: T, userId: U, state: 'SUBMITTED' }),
    ).rejects.toThrow(/no row returned/)
  })
})

describe('pendingCancellationFor', () => {
  it('returns the open request, scoped to this transfer AND status=pending', async () => {
    q('cancellation_requests', { data: requestRow(), error: null })

    await expect(pendingCancellationFor(T)).resolves.toMatchObject({ id: 'cr-1', status: 'pending' })

    // Both filters on the one builder: without the status filter a RESOLVED
    // request would read as open and re-arm the tails on a closed ask.
    const lookupFilters = filters
      .filter((f) => f.table === 'cancellation_requests' && f.method !== 'select')
      .map((f) => [f.method, ...f.args])
    expect(lookupFilters).toEqual([
      ['eq', 'transfer_id', T],
      ['eq', 'status', 'pending'],
    ])
    // The column list is the read contract: within_window and requested_at are
    // what tail 2 routes on, so they must actually be selected.
    const selected = String(filters.find((f) => f.method === 'select')?.args[0])
    expect(selected).toBe(
      'id, transfer_id, user_id, requested_at, requested_state, within_window, status, resolution, resolved_at, resolved_by, created_at, updated_at',
    )
  })

  it('returns null when nothing is pending', async () => {
    q('cancellation_requests', { data: null, error: null })
    await expect(pendingCancellationFor(T)).resolves.toBeNull()
  })

  it('fails closed on a query error — a broken read must never read as "no request"', async () => {
    // Tail 2 treats null as "nothing pending" and moves on. On an error that
    // must be a THROW (the job's catch pages); silently returning null would
    // retire the event with the request unrouted and nobody told.
    q('cancellation_requests', { data: null, error: { message: 'db down' } })
    await expect(pendingCancellationFor(T)).rejects.toThrow(/pending cancellation query failed/)
  })
})

describe('resolveCancellationRequest', () => {
  const resolveInput = {
    transferId: T,
    status: 'resolved_refunded' as const,
    resolution: 'refunded in full by the payout-failure tail',
    resolvedBy: 'worker:payment-event',
  }

  it('closes the request with the caller’s resolution and stamps resolved_at', async () => {
    q('cancellation_requests', { data: [{ id: 'cr-1' }], error: null })

    await expect(resolveCancellationRequest(resolveInput)).resolves.toBe(true)

    const update = filters.find((f) => f.method === 'update')
    expect(update?.args[0]).toMatchObject({
      status: 'resolved_refunded',
      resolution: 'refunded in full by the payout-failure tail',
      resolved_by: 'worker:payment-event',
    })
    expect((update?.args[0] as Record<string, unknown>).resolved_at).toEqual(expect.any(String))
  })

  it('guards the update on transfer_id AND status=pending — first resolution wins, replays write nothing', async () => {
    q('cancellation_requests', { data: [{ id: 'cr-1' }], error: null })

    await resolveCancellationRequest(resolveInput)

    // Attributed to the UPDATE's own builder. Without the pending guard, tail 1
    // re-running from already_settled would overwrite an operator's earlier
    // resolved_denied — the record of WHO closed the statutory ask and WHY
    // must be append-once.
    const update = filters.find((f) => f.method === 'update')
    const guardFilters = filters
      .filter((f) => f.builder === update?.builder && f.method !== 'update')
      .map((f) => [f.method, ...f.args])
    expect(guardFilters).toEqual([
      ['eq', 'transfer_id', T],
      ['eq', 'status', 'pending'],
      ['select', 'id'],
    ])
  })

  it('returns false when the request was already closed (or never open)', async () => {
    // False means "this call resolved nothing" — tail callers use it to avoid
    // reporting a resolution they did not make.
    q('cancellation_requests', { data: [], error: null })
    await expect(resolveCancellationRequest(resolveInput)).resolves.toBe(false)
  })

  it('coalesces a null-without-error result to false, never to a claimed resolution', async () => {
    q('cancellation_requests', { data: null, error: null })
    await expect(resolveCancellationRequest(resolveInput)).resolves.toBe(false)
  })

  it('throws on an update error rather than reporting an unresolved close', async () => {
    q('cancellation_requests', { data: null, error: { message: 'db down' } })
    await expect(resolveCancellationRequest(resolveInput)).rejects.toThrow(
      /resolve cancellation failed/,
    )
  })
})
