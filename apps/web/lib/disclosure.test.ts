import { describe, it, expect } from 'vitest'
import { isRenderedDisclosure, isReceiptContent } from './disclosure'

const rendered = {
  title: 'Transfer receipt',
  amountLines: ['Transfer amount: $99.00', 'Transfer fee: $1.00'],
  fxRateLine: 'Exchange rate: 1 USD = 19.9997 MXN',
  cancellationRights: 'You can cancel within 30 minutes…',
  errorResolutionRights: 'If you think there is an error…',
  wrongAccountWarning: 'If the account number is wrong…',
  contact: 'Puente Financial — support@puentefinancial.com',
}

const receipt = { content: { en: rendered, es: rendered }, presentedAt: '2026-07-24T20:00:00.000Z' }

describe('isRenderedDisclosure', () => {
  it('accepts a well-formed rendering', () => {
    expect(isRenderedDisclosure(rendered)).toBe(true)
  })

  it('rejects anything not shaped like a rendering (guards the verbatim render)', () => {
    expect(isRenderedDisclosure(null)).toBe(false)
    expect(isRenderedDisclosure({})).toBe(false)
    expect(isRenderedDisclosure('<html>not json</html>')).toBe(false)
    expect(isRenderedDisclosure({ ...rendered, title: 42 })).toBe(false)
    expect(isRenderedDisclosure({ ...rendered, amountLines: 'nope' })).toBe(false)
    expect(isRenderedDisclosure({ ...rendered, amountLines: ['ok', 5] })).toBe(false)
    expect(isRenderedDisclosure({ ...rendered, contact: undefined })).toBe(false)
  })
})

describe('isReceiptContent', () => {
  it('accepts a well-formed receipt body', () => {
    expect(isReceiptContent(receipt)).toBe(true)
  })

  it('rejects bodies missing either language or the timestamp', () => {
    expect(isReceiptContent(null)).toBe(false)
    expect(isReceiptContent({})).toBe(false)
    expect(isReceiptContent('<html>not json</html>')).toBe(false)
    expect(isReceiptContent({ content: { en: rendered, es: rendered } })).toBe(false) // no presentedAt
    expect(isReceiptContent({ ...receipt, content: { en: rendered } })).toBe(false) // no es
    expect(isReceiptContent({ ...receipt, content: { en: rendered, es: {} } })).toBe(false)
    expect(isReceiptContent({ ...receipt, presentedAt: 123 })).toBe(false)
  })
})
