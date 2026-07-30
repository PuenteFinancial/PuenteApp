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
      // (b)(2)(v): name + website; telephone pending provisioning (package §7).
      // Whole-line pin — the domain is a substring of the email, so a
      // toContain('puentefinancial.com') passes even with the website deleted.
      expect(rendered['contact']).toBe(
        'Puente Financial · support@puentefinancial.com · puentefinancial.com',
      )
    }
  })

  // PR7 (counsel package §4.1/§4.3): the extinguishing event is §1005.34(a)(2)
  // "picked up or deposited" — v1's "submitted for payout" was stricter than
  // the law and must never come back. Same guard for the 180-day anchor.
  it('states the §1005.34 extinguishing event, not the v1 submitted-for-payout rule', () => {
    const { content } = buildPrepaymentDisclosure(amounts, 'en', 30)
    const en = content['en'] as { cancellationRights: string; errorResolutionRights: string }
    const es = content['es'] as { cancellationRights: string; errorResolutionRights: string }
    expect(en.cancellationRights).toContain('picked up by your recipient or deposited')
    expect(en.cancellationRights).not.toContain('submitted for payout')
    expect(es.cancellationRights).toContain('retirados por el destinatario o depositados')
    expect(es.cancellationRights).not.toContain('enviados para su entrega')
    expect(en.errorResolutionRights).toContain('date we promised the funds would be available')
    expect(es.errorResolutionRights).toContain('estarían disponibles')
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
  const facts = {
    dateAvailableIso: '2026-07-29T18:00:00.000Z', // 12:00 CDMX
    recipientFirstName: 'María',
    recipientLastName: 'Hernández García',
  }

  it('is the prepayment content PLUS the §1005.31(b)(2) receipt items, en+es parity', () => {
    const receipt = buildReceiptDisclosure(amounts, 'es', 30, facts)
    expect(receipt.locale).toBe('es')
    expect(receipt.content['version']).toBe(DISCLOSURE_VERSION)
    // delivered = disclosed terms: the numbers are the prepayment numbers
    expect(receipt.content['amounts']).toEqual(
      buildPrepaymentDisclosure(amounts, 'es', 30).content['amounts'],
    )
    const en = receipt.content['en'] as Record<string, string>
    const es = receipt.content['es'] as Record<string, string>
    // (b)(2) identity: a receipt announces itself as one
    expect(en['title']).toBe('Receipt')
    expect(es['title']).toBe('Recibo')
    // (b)(2)(iii) recipient, (b)(2)(ii) date available — both languages
    expect(en['recipientLine']).toBe('Recipient: María Hernández García')
    expect(es['recipientLine']).toBe('Destinatario: María Hernández García')
    expect(en['dateAvailableLine']).toBe('Date available: July 29, 2026')
    expect(es['dateAvailableLine']).toBe('Fecha de disponibilidad: 29 de julio de 2026')
    // the (b)(1) content rides along unchanged
    for (const rendered of [en, es]) {
      expect(rendered['amountLines']).toHaveLength(4)
      expect(rendered['cancellationRights']).toContain('30')
      expect(rendered['errorResolutionRights']).toContain('180')
      expect(rendered['contact']).toContain('support@puentefinancial.com')
    }
  })

  it('renders the date available as the CDMX calendar day, not the UTC day', () => {
    // 03:00Z on the 30th is still 21:00 on the 29th in Mexico City —
    // §1005.31(b)(2)(ii) wants "the date in the foreign country".
    const receipt = buildReceiptDisclosure(amounts, 'en', 30, {
      ...facts,
      dateAvailableIso: '2026-07-30T03:00:00.000Z',
    })
    const en = receipt.content['en'] as Record<string, string>
    const es = receipt.content['es'] as Record<string, string>
    expect(en['dateAvailableLine']).toBe('Date available: July 29, 2026')
    expect(es['dateAvailableLine']).toBe('Fecha de disponibilidad: 29 de julio de 2026')
  })

  it('leaves the prepayment rendering free of receipt-only fields', () => {
    const { content } = buildPrepaymentDisclosure(amounts, 'en', 30)
    for (const lang of ['en', 'es'] as const) {
      const rendered = content[lang] as Record<string, unknown>
      expect(rendered['recipientLine']).toBeUndefined()
      expect(rendered['dateAvailableLine']).toBeUndefined()
      expect(rendered['title']).not.toBe('Receipt')
      expect(rendered['title']).not.toBe('Recibo')
    }
  })

  it('records the presented locale (en) while carrying both renderings', () => {
    const receipt = buildReceiptDisclosure(amounts, 'en', 30, facts)
    expect(receipt.locale).toBe('en')
    expect(receipt.content['en']).toBeTruthy()
    expect(receipt.content['es']).toBeTruthy()
  })
})
