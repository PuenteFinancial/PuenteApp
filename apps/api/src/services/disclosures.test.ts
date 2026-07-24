import { describe, it, expect } from 'vitest'
import {
  buildPrepaymentDisclosure,
  buildReceiptDisclosure,
  DISCLOSURE_VERSION,
} from './disclosures.js'

const amounts = { sendMinor: 19801, feeMinor: 199, receiveMinor: 396014, fxRate: '19.9997' }

describe('buildPrepaymentDisclosure', () => {
  it('stores the exact numbers once and renders BOTH languages (i18n parity)', () => {
    const { locale, content } = buildPrepaymentDisclosure(amounts, 'es', 30)
    expect(locale).toBe('es')
    expect(content['version']).toBe(DISCLOSURE_VERSION)
    expect(content['amounts']).toEqual({
      sendMinor: 19801,
      feeMinor: 199,
      totalMinor: 20000,
      sendCurrency: 'USD',
      receiveMinor: 396014,
      receiveCurrency: 'MXN',
      fxRate: '19.9997',
    })

    for (const lang of ['en', 'es'] as const) {
      const rendered = content[lang] as Record<string, unknown>
      expect(rendered['title']).toBeTruthy()
      expect(rendered['amountLines']).toHaveLength(4)
      expect(rendered['fxRateLine']).toContain('19.9997')
      expect(rendered['cancellationRights']).toContain('30')
      expect(rendered['errorResolutionRights']).toContain('180')
      // §1005.33(h) safe harbor: the wrong-account warning lives INSIDE the doc
      expect(rendered['wrongAccountWarning']).toContain('CLABE')
      expect(rendered['contact']).toContain('support@puentefinancial.com')
    }
  })

  // WHOLE-LINE assertions, not toContain(<number>). A substring match on the
  // amount passes for both "$198.01 USD" and the garbled "USD 198.01 USD" that
  // shipped in the Spanish rendering for months — Intl renders USD with a code
  // prefix in the es-MX locale, and the renderer appended " USD" on top.
  it('formats the customer-facing amounts from minor units (en)', () => {
    const { content } = buildPrepaymentDisclosure(amounts, 'en', 30)
    const en = content['en'] as { amountLines: string[] }
    expect(en.amountLines).toEqual([
      'Transfer amount: $198.01',
      'Transfer fee: $1.99',
      'Total to pay: $200.00',
      'Amount to be received: $3,960.14 MXN',
    ])
  })

  it('formats the customer-facing amounts from minor units (es)', () => {
    const { content } = buildPrepaymentDisclosure(amounts, 'es', 30)
    const es = content['es'] as { amountLines: string[] }
    expect(es.amountLines).toEqual([
      'Monto de la transferencia: $198.01 USD',
      'Comisión por transferencia: $1.99 USD',
      'Total a pagar: $200.00 USD',
      'Monto a recibir: $3,960.14 MXN',
    ])
  })

  it('never repeats a currency label in either rendering', () => {
    // The specific defect, pinned: "USD 198.01 USD".
    const { content } = buildPrepaymentDisclosure(amounts, 'es', 30)
    for (const locale of ['en', 'es'] as const) {
      const lines = (content[locale] as { amountLines: string[] }).amountLines
      for (const line of lines) {
        expect(line.match(/USD/g)?.length ?? 0).toBeLessThanOrEqual(1)
        expect(line.match(/MXN/g)?.length ?? 0).toBeLessThanOrEqual(1)
      }
    }
  })

  it('respects a configured cancel window', () => {
    const { content } = buildPrepaymentDisclosure(amounts, 'en', 45)
    const en = content['en'] as { cancellationRights: string }
    const es = content['es'] as { cancellationRights: string }
    expect(en.cancellationRights).toContain('45 minutes')
    expect(es.cancellationRights).toContain('45 minutos')
    expect(content['cancelWindowMinutes']).toBe(45)
  })

  it('handles zero-fee transfers', () => {
    const { content } = buildPrepaymentDisclosure({ ...amounts, feeMinor: 0 }, 'en', 30)
    const a = content['amounts'] as { feeMinor: number; totalMinor: number }
    expect(a.feeMinor).toBe(0)
    expect(a.totalMinor).toBe(19801)
  })
})

describe('buildReceiptDisclosure', () => {
  it('reuses the prepayment content verbatim with en+es parity (delivered = disclosed terms)', () => {
    const receipt = buildReceiptDisclosure(amounts, 'es', 30)
    // slice-6 PR3: same numbers, same copy — no new counsel-pending wording yet
    expect(receipt).toEqual(buildPrepaymentDisclosure(amounts, 'es', 30))
    expect(receipt.locale).toBe('es')
    expect(receipt.content['version']).toBe(DISCLOSURE_VERSION)
    expect(receipt.content['amounts']).toMatchObject({
      totalMinor: 20000,
      receiveMinor: 396014,
      fxRate: '19.9997',
    })
    for (const lang of ['en', 'es'] as const) {
      const rendered = receipt.content[lang] as Record<string, unknown>
      expect(rendered['amountLines']).toHaveLength(4)
      expect(rendered['contact']).toContain('support@puentefinancial.com')
    }
  })

  it('records the presented locale (en) while carrying both renderings', () => {
    const receipt = buildReceiptDisclosure(amounts, 'en', 30)
    expect(receipt.locale).toBe('en')
    expect(receipt.content['en']).toBeTruthy()
    expect(receipt.content['es']).toBeTruthy()
  })
})
