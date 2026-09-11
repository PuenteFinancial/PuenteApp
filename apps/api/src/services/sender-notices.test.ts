import { describe, it, expect, vi, beforeEach } from 'vitest'

const from = vi.fn()
vi.mock('./supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const captureMessage = vi.hoisted(() => vi.fn())
const setFingerprint = vi.hoisted(() => vi.fn())
const setContext = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
  withScope: (fn: (scope: unknown) => void) => fn({ setFingerprint, setContext }),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}))

const { recordAccountFrozenNotice, renderAccountFrozenNotice, noticeLanguage } = await import(
  './sender-notices.js'
)

const USER_ID = 'dddddddd-1111-4222-8333-444444444444'
const TRANSFER_ID = 'cccccccc-1111-4222-8333-444444444444'

const log = { info: vi.fn(), error: vi.fn() }

function noticesTable(result: { error: unknown }) {
  const insert = vi.fn(async (..._args: unknown[]) => result)
  from.mockReturnValue({ insert })
  return insert
}

beforeEach(() => {
  from.mockReset()
  captureMessage.mockReset()
  setFingerprint.mockReset()
  setContext.mockReset()
  log.info.mockClear()
  log.error.mockClear()
})

describe('the copy itself', () => {
  it.each(['en', 'es'] as const)('%s says what is wrong at a general level and where to go', (lang) => {
    const { subject, body } = renderAccountFrozenNotice(lang)
    expect(subject.length).toBeGreaterThan(0)
    expect(body).toContain('support@puentefinancial.com')
  })

  it('discloses NO dispute specifics — nothing that helps a fraudulent actor', () => {
    // A notice naming the return code, the amount, the transfer, or the
    // deadline tells someone who just stole a card exactly what we know and how
    // long they have. The in-product string it must agree with says only "a
    // problem with a payment"; so does this.
    for (const lang of ['en', 'es'] as const) {
      const body = renderAccountFrozenNotice(lang).body.toLowerCase()
      for (const leak of ['chargeback', 'dispute', 'fraud', 'r01', 'r10', 'contracargo', 'fraude']) {
        expect(body).not.toContain(leak)
      }
    }
  })

  it('names the right the freeze deliberately leaves alone', () => {
    // Cancellation stays available to a frozen sender (Reg E, and
    // requireOnboardedUser gates everything BUT cancel). A notice that let the
    // freeze read as total would make the sender abandon money they can still
    // get back.
    expect(renderAccountFrozenNotice('en').body).toContain('cancel it')
    expect(renderAccountFrozenNotice('es').body).toContain('cancelarla')
  })

  it('interpolates nothing, so the stored text can never carry PII', () => {
    // The rendered body is what lands in sender_notices.body. It is a constant
    // per language; if that ever stops being true, storing it stops being safe.
    expect(renderAccountFrozenNotice('en')).toBe(renderAccountFrozenNotice('en'))
    expect(renderAccountFrozenNotice('en').body).not.toBe(renderAccountFrozenNotice('es').body)
  })
})

describe('noticeLanguage', () => {
  it('honours es and falls back to the column default for anything else', () => {
    expect(noticeLanguage('es')).toBe('es')
    expect(noticeLanguage('en')).toBe('en')
    // A failed pre-read (null) must still produce a notice, not an exception.
    expect(noticeLanguage(null)).toBe('en')
    expect(noticeLanguage(undefined)).toBe('en')
    expect(noticeLanguage('pt')).toBe('en')
  })
})

describe('recordAccountFrozenNotice', () => {
  it("stores the notice in the sender's language and pages an operator to deliver it", async () => {
    const insert = noticesTable({ error: null })

    expect(await recordAccountFrozenNotice({ userId: USER_ID, transferId: TRANSFER_ID, language: 'es' }, log)).toBe(
      true,
    )

    expect(from).toHaveBeenCalledWith('sender_notices')
    const row = insert.mock.calls[0]![0] as Record<string, unknown>
    expect(row).toMatchObject({
      user_id: USER_ID,
      transfer_id: TRANSFER_ID,
      kind: 'account_frozen',
      language: 'es',
      // There is no automated channel: the page IS the delivery mechanism, and
      // the row must say so rather than implying something was sent.
      channel: 'manual',
      status: 'pending',
    })
    expect(row['body']).toBe(renderAccountFrozenNotice('es').body)

    // The page carries the exact words, so an operator does not improvise copy
    // that has had no review.
    expect(captureMessage).toHaveBeenCalledWith(expect.stringContaining('deliver it manually'), 'error')
    expect(setContext).toHaveBeenCalledWith(
      'notice',
      expect.objectContaining({ language: 'es', body: renderAccountFrozenNotice('es').body }),
    )
  })

  it('a failed write is reported and returns false — it never throws at the freeze', async () => {
    // The freeze has already landed by the time this runs. Throwing would turn
    // a missing notice into a webhook 500, and a redelivery cannot un-freeze
    // anyone, so the only thing it would achieve is noise.
    noticesTable({ error: { code: '23503', message: 'fk violation' } })

    expect(await recordAccountFrozenNotice({ userId: USER_ID, transferId: TRANSFER_ID, language: 'en' }, log)).toBe(
      false,
    )

    expect(log.error).toHaveBeenCalled()
    expect(setFingerprint).toHaveBeenCalledWith(['sender-notice-write-failed', 'account_frozen'])
    expect(captureMessage).toHaveBeenCalledWith('sender notice write failed', 'error')
  })

  it('a thrown insert is caught too, not just a returned error', async () => {
    from.mockReturnValue({
      insert: async () => {
        throw new Error('socket hang up')
      },
    })

    await expect(
      recordAccountFrozenNotice({ userId: USER_ID, transferId: TRANSFER_ID, language: 'en' }, log),
    ).resolves.toBe(false)
  })

  it('does not reject even when the REPORTING fails', async () => {
    // "Never rejects" has to hold through the failure path too: a broken logger
    // or an unavailable Sentry transport must not be the thing that 500s a
    // webhook and makes the provider redeliver a dispute already acted on.
    noticesTable({ error: { code: '23503', message: 'fk violation' } })
    const brokenLog = {
      info: vi.fn(),
      error: () => {
        throw new Error('logger is down')
      },
    }

    await expect(
      recordAccountFrozenNotice({ userId: USER_ID, transferId: TRANSFER_ID, language: 'en' }, brokenLog),
    ).resolves.toBe(false)
  })

  it('accepts a null transfer, for a freeze with no single transfer behind it', async () => {
    const insert = noticesTable({ error: null })
    await recordAccountFrozenNotice({ userId: USER_ID, transferId: null, language: 'en' }, log)
    expect((insert.mock.calls[0]![0] as Record<string, unknown>)['transfer_id']).toBeNull()
  })
})
