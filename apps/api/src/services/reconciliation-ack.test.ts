import { describe, it, expect, beforeEach, vi } from 'vitest'

// The acknowledgement service. The registry is mocked so these tests pin the RULES — what may be
// acknowledged, for how long, and by whom — without depending on which checks happen to exist.
// The runner's use of them (fail-open, fatal never suppressed, counts on the run row) is in
// jobs/ledger-reconcile.test.ts.

const buildChecks = vi.hoisted(() => vi.fn())
vi.mock('./reconciliation.js', () => ({
  buildChecks: (...args: unknown[]) => buildChecks(...args),
}))

const from = vi.fn()
vi.mock('./supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const {
  ackKey,
  acknowledgeRefusal,
  findAcknowledgeRefusal,
  partitionFindings,
  loadActiveAcknowledgements,
  acknowledgeFinding,
  revokeAcknowledgement,
  MAX_ACK_DAYS,
} = await import('./reconciliation-ack.js')

const mkCheck = (name: string, severity: 'fatal' | 'error' | 'warning') => ({
  name,
  severity,
  runbook: 'docs/runbooks/reconciliation.md',
  run: vi.fn(),
})

const NOW = Date.parse('2026-09-15T12:00:00.000Z')

const row = (over: Record<string, unknown> = {}) => ({
  id: 'ack-1',
  check_name: 'stripe_disputes',
  finding_key: 'dispute:du_1',
  actor: 'ops:abc',
  note: 'investigated — predates the loss path',
  expires_at: '2026-11-01T00:00:00.000Z',
  revoked_at: null,
  created_at: '2026-09-15T00:00:00.000Z',
  ...over,
})

beforeEach(() => {
  buildChecks.mockReset().mockReturnValue([
    mkCheck('ledger_net_zero', 'fatal'),
    mkCheck('stripe_disputes', 'error'),
    mkCheck('transfer_aging', 'warning'),
  ])
  from.mockReset()
})

describe('ackKey', () => {
  it('cannot be collided by a finding key that contains the separator', () => {
    // Finding keys routinely contain colons ('stripe-dispute-unrecorded:du_1ABC'), so a colon
    // join would let one check's key impersonate another's.
    expect(ackKey('a', 'b:c')).not.toBe(ackKey('a:b', 'c'))
  })
})

describe('acknowledgeRefusal', () => {
  const ok = { checkName: 'stripe_disputes', note: 'a good enough reason', days: 30 }

  it('accepts a well-formed acknowledgement', () => {
    expect(acknowledgeRefusal(ok)).toBeNull()
  })

  it('refuses a check name that is not in the registry, and lists the real ones', () => {
    // A typo would otherwise write a row that silences nothing and reads, forever after, as
    // though someone had handled the finding.
    const refusal = acknowledgeRefusal({ ...ok, checkName: 'stripe_disputez' })
    expect(refusal).toMatchObject({ reason: 'unknown_check' })
    expect((refusal as { known: string[] }).known).toContain('stripe_disputes')
  })

  it('refuses a FATAL check', () => {
    expect(acknowledgeRefusal({ ...ok, checkName: 'ledger_net_zero' })).toEqual({
      reason: 'fatal_check',
    })
  })

  it('refuses a note too short to say anything', () => {
    expect(acknowledgeRefusal({ ...ok, note: 'fine' })).toMatchObject({ reason: 'bad_note' })
  })

  it('refuses a window of zero, a fraction, or longer than the cap', () => {
    for (const days of [0, -1, 2.5, MAX_ACK_DAYS + 1]) {
      expect(acknowledgeRefusal({ ...ok, days })).toMatchObject({ reason: 'bad_window' })
    }
    expect(acknowledgeRefusal({ ...ok, days: MAX_ACK_DAYS })).toBeNull()
  })
})

describe('partitionFindings', () => {
  const findings = [{ key: 'k1', detail: {} }, { key: 'k2', detail: {} }]
  const active = new Map([['x', { checkName: 'c', findingKey: 'k1' }]] as never)

  it('splits on the acknowledged key', () => {
    const map = new Map([[ackKey('c', 'k1'), row() as never]])
    const out = partitionFindings({ checkName: 'c', severity: 'warning', findings, active: map })
    expect(out.acknowledged.map((f) => f.key)).toEqual(['k1'])
    expect(out.pageable.map((f) => f.key)).toEqual(['k2'])
  })

  it('suppresses nothing on a fatal check, whatever the table says', () => {
    const map = new Map([[ackKey('c', 'k1'), row() as never]])
    const out = partitionFindings({ checkName: 'c', severity: 'fatal', findings, active: map })
    expect(out.pageable).toHaveLength(2)
    expect(out.acknowledged).toHaveLength(0)
  })

  it('passes everything through when nothing is acknowledged', () => {
    void active
    const out = partitionFindings({
      checkName: 'c',
      severity: 'error',
      findings,
      active: new Map(),
    })
    expect(out.pageable).toHaveLength(2)
  })
})

describe('loadActiveAcknowledgements', () => {
  it('keys rows by (check, finding) and filters to unrevoked, unexpired', async () => {
    const gt = vi.fn().mockResolvedValue({ data: [row()], error: null })
    const is = vi.fn().mockReturnValue({ gt })
    const select = vi.fn().mockReturnValue({ is })
    from.mockReturnValue({ select })

    const active = await loadActiveAcknowledgements(NOW)

    expect(is).toHaveBeenCalledWith('revoked_at', null)
    expect(gt).toHaveBeenCalledWith('expires_at', new Date(NOW).toISOString())
    expect(active.get(ackKey('stripe_disputes', 'dispute:du_1'))).toMatchObject({ id: 'ack-1' })
  })

  it('THROWS on a read failure rather than returning an empty map', async () => {
    // An empty map and a failed read are the same value with opposite meanings. The runner has
    // to be able to tell them apart to fail open on purpose.
    const gt = vi.fn().mockResolvedValue({ data: null, error: { message: 'denied' } })
    from.mockReturnValue({ select: () => ({ is: () => ({ gt }) }) })

    await expect(loadActiveAcknowledgements(NOW)).rejects.toThrow(/read failed: denied/)
  })
})

describe('findAcknowledgeRefusal', () => {
  // This exists so the CLI's DRY RUN reaches the same verdict as --confirm. It previously did
  // not: a misspelled check name or a fatal one previewed as though it would work, and was
  // rejected only once you committed. A preview that does not run the real decision is worse
  // than no preview, because it is believed.
  const args = {
    checkName: 'stripe_disputes',
    findingKey: 'dispute:du_1',
    note: 'investigated — predates the loss path',
    days: 30,
    nowMs: NOW,
  }
  const mockLoad = (rows: Array<Record<string, unknown>>) => ({
    select: () => ({ is: () => ({ gt: () => Promise.resolve({ data: rows, error: null }) }) }),
  })

  it('reports a typo WITHOUT touching the database', async () => {
    from.mockImplementation(() => {
      throw new Error('should not reach the database')
    })
    await expect(findAcknowledgeRefusal({ ...args, checkName: 'stripe_disputez' })).resolves.toMatchObject({
      reason: 'unknown_check',
    })
  })

  it('reports a fatal check WITHOUT touching the database', async () => {
    from.mockImplementation(() => {
      throw new Error('should not reach the database')
    })
    await expect(findAcknowledgeRefusal({ ...args, checkName: 'ledger_net_zero' })).resolves.toEqual({
      reason: 'fatal_check',
    })
  })

  it('reports an acknowledgement already in force', async () => {
    from.mockReturnValue(mockLoad([row({ note: 'someone else already looked' })]))
    await expect(findAcknowledgeRefusal(args)).resolves.toMatchObject({
      reason: 'already_acknowledged',
    })
  })

  it('returns null when the acknowledgement would be accepted', async () => {
    from.mockReturnValue(mockLoad([]))
    await expect(findAcknowledgeRefusal(args)).resolves.toBeNull()
  })
})

describe('acknowledgeFinding', () => {
  const args = {
    checkName: 'stripe_disputes',
    findingKey: 'dispute:du_1',
    actor: 'ops:abc',
    note: 'investigated — predates the loss path',
    days: 30,
    nowMs: NOW,
  }

  const mockLoad = (rows: Array<Record<string, unknown>>) => ({
    select: vi.fn().mockReturnValue({
      is: () => ({ gt: () => Promise.resolve({ data: rows, error: null }) }),
    }),
  })

  it('writes an expiry computed from the window, not a caller-supplied date', async () => {
    const single = vi.fn().mockResolvedValue({ data: row(), error: null })
    const insert = vi.fn().mockReturnValue({ select: () => ({ single }) })
    from.mockReturnValue({ ...mockLoad([]), insert })

    const outcome = await acknowledgeFinding(args)

    expect(outcome.done).toBe(true)
    const written = insert.mock.calls[0]?.[0] as Record<string, unknown>
    expect(written['expires_at']).toBe(new Date(NOW + 30 * 24 * 60 * 60_000).toISOString())
    expect(written['check_name']).toBe('stripe_disputes')
    expect(written['actor']).toBe('ops:abc')
  })

  it('refuses before touching the database when the check is fatal', async () => {
    from.mockImplementation(() => {
      throw new Error('should not reach the database')
    })
    const outcome = await acknowledgeFinding({ ...args, checkName: 'ledger_net_zero' })
    expect(outcome).toEqual({ done: false, refusal: { reason: 'fatal_check' } })
  })

  it('refuses a duplicate and hands back the acknowledgement already in force', async () => {
    // Not because a duplicate breaks anything, but because the second operator should read the
    // first one's note before deciding this is handled.
    from.mockReturnValue(mockLoad([row({ note: 'someone else already looked' })]))

    const outcome = await acknowledgeFinding(args)

    expect(outcome.done).toBe(false)
    expect((outcome as { refusal: { reason: string; existing: { note: string } } }).refusal).toMatchObject({
      reason: 'already_acknowledged',
      existing: { note: 'someone else already looked' },
    })
  })
})

describe('revokeAcknowledgement', () => {
  const mockRead = (found: Record<string, unknown> | null) => ({
    select: vi.fn().mockReturnValue({
      eq: () => ({ maybeSingle: () => Promise.resolve({ data: found, error: null }) }),
    }),
  })

  it('stamps revoked_at and keeps the row', async () => {
    const maybeSingle = vi
      .fn()
      .mockResolvedValue({ data: row({ revoked_at: '2026-09-15T12:00:00.000Z' }), error: null })
    const update = vi.fn().mockReturnValue({
      eq: () => ({ is: () => ({ select: () => ({ maybeSingle }) }) }),
    })
    from.mockReturnValue({ ...mockRead(row()), update })

    const outcome = await revokeAcknowledgement({ id: 'ack-1', nowMs: NOW })

    expect(outcome.done).toBe(true)
    expect(update).toHaveBeenCalledWith({ revoked_at: new Date(NOW).toISOString() })
  })

  it('reports rather than writes when the acknowledgement already expired', async () => {
    // Revoking something that is already silent-no-more would add a revocation that changed
    // nothing to the row's history.
    from.mockReturnValue(mockRead(row({ expires_at: '2026-09-01T00:00:00.000Z' })))

    await expect(revokeAcknowledgement({ id: 'ack-1', nowMs: NOW })).resolves.toEqual({
      done: false,
      reason: 'expired',
    })
  })

  it('reports already_revoked instead of writing twice', async () => {
    from.mockReturnValue(mockRead(row({ revoked_at: '2026-09-14T00:00:00.000Z' })))

    await expect(revokeAcknowledgement({ id: 'ack-1', nowMs: NOW })).resolves.toEqual({
      done: false,
      reason: 'already_revoked',
    })
  })

  it('reports not_found for an id that does not exist', async () => {
    from.mockReturnValue(mockRead(null))

    await expect(revokeAcknowledgement({ id: 'ack-1', nowMs: NOW })).resolves.toEqual({
      done: false,
      reason: 'not_found',
    })
  })
})
