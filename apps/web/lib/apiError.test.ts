import { describe, it, expect } from 'vitest'
import { parseApiError, errorMessage, parseCancellationRequiresSupport } from './apiError'
import { translations } from './translations'

const errors = translations.en.send.errors

describe('parseApiError', () => {
  it('extracts code, message and requestId from the envelope', () => {
    const body = { error: { code: 'quote_expired', message: 'Quote has expired', requestId: 'req_1' } }
    expect(parseApiError(body)).toEqual({
      code: 'quote_expired',
      message: 'Quote has expired',
      requestId: 'req_1',
    })
  })

  it('tolerates a code-only envelope', () => {
    expect(parseApiError({ error: { code: 'kyc_required' } })).toEqual({ code: 'kyc_required' })
  })

  it('returns null for anything not shaped like the envelope', () => {
    expect(parseApiError(null)).toBeNull()
    expect(parseApiError({})).toBeNull()
    expect(parseApiError({ error: 'nope' })).toBeNull()
    expect(parseApiError({ error: {} })).toBeNull() // missing code
    expect(parseApiError('a string')).toBeNull()
  })
})

describe('errorMessage', () => {
  it('maps a known code to its localized message', () => {
    expect(errorMessage('quote_expired', errors)).toBe(errors.quote_expired)
    expect(errorMessage('not_configured', errors)).toBe(errors.not_configured)
  })

  it('falls back to generic for unknown or missing codes', () => {
    expect(errorMessage('some_future_code', errors)).toBe(errors.generic)
    expect(errorMessage(undefined, errors)).toBe(errors.generic)
    expect(errorMessage(null, errors)).toBe(errors.generic)
  })

  it('never treats inherited Object properties as codes', () => {
    expect(errorMessage('toString', errors)).toBe(errors.generic)
    expect(errorMessage('constructor', errors)).toBe(errors.generic)
    expect(errorMessage('hasOwnProperty', errors)).toBe(errors.generic)
  })

  it('resolves the Spanish map too', () => {
    const es = translations.es.send.errors
    expect(errorMessage('kyc_required', es)).toBe(es.kyc_required)
  })
})

describe('parseCancellationRequiresSupport', () => {
  it('extracts the localized messages from the 202 cancel body', () => {
    const body = {
      id: 't1',
      state: 'SUBMITTED',
      code: 'cancellation_requires_support',
      messages: { en: 'EN copy', es: 'ES copy' },
    }
    expect(parseCancellationRequiresSupport(body)).toEqual({ en: 'EN copy', es: 'ES copy' })
  })

  it('returns null when the body is not that shape', () => {
    expect(
      parseCancellationRequiresSupport({ code: 'other', messages: { en: 'x', es: 'y' } }),
    ).toBeNull()
    expect(parseCancellationRequiresSupport({ code: 'cancellation_requires_support' })).toBeNull()
    expect(parseCancellationRequiresSupport(null)).toBeNull()
  })
})
