import { describe, it, expect } from 'vitest'
import { buildPrepaymentDisclosure, DISCLOSURE_VERSION } from './disclosures.js'

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

  it('formats the customer-facing amounts from minor units', () => {
    const { content } = buildPrepaymentDisclosure(amounts, 'en', 30)
    const en = content['en'] as { amountLines: string[] }
    expect(en.amountLines[0]).toContain('198.01')
    expect(en.amountLines[1]).toContain('1.99')
    expect(en.amountLines[2]).toContain('200.00')
    expect(en.amountLines[3]).toContain('3,960.14')
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
