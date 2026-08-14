import { beforeEach, describe, expect, it, vi } from 'vitest'

// The fetchers call the api singleton, which is a module singleton on purpose
// (lib/api.ts) — mocking it here is what lets them be tested at all without a
// device or a live server.
const mockFetch = vi.fn()
vi.mock('../api', () => ({
  api: {
    fetch: (...args: unknown[]) => mockFetch(...args) as unknown,
  },
}))

const {
  ApiRequestError,
  fetchDestinations,
  fetchRecipients,
  isKycGateError,
  recipientKeys,
  shouldRetry,
} = await import('./recipients')

const jsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as Response

beforeEach(() => {
  mockFetch.mockReset()
})

describe('recipientKeys', () => {
  it('nests every key under one root so a mutation can invalidate the subtree', () => {
    // This is the whole point of the factory: archiving a recipient cascades to
    // its destinations server-side, so the mutation invalidates `all` rather
    // than trying to name every key it might have touched.
    const root = recipientKeys.all
    expect(recipientKeys.list().slice(0, root.length)).toEqual([...root])
    expect(recipientKeys.destinations('r-1').slice(0, root.length)).toEqual([...root])
  })

  it('gives different recipients different destination keys', () => {
    // Sharing a key would serve one recipient's accounts under another's name —
    // a cache collision that shows up as money aimed at the wrong person.
    expect(recipientKeys.destinations('r-1')).not.toEqual(recipientKeys.destinations('r-2'))
  })
})

describe('shouldRetry', () => {
  it('retries a transport failure — no response is the transient case', () => {
    expect(shouldRetry(0, new TypeError('Network request failed'))).toBe(true)
  })

  it('retries a 500', () => {
    expect(shouldRetry(0, new ApiRequestError(500))).toBe(true)
  })

  it.each([[400], [401], [403], [404], [409], [422]])(
    'does not retry %i — a settled answer cannot change',
    (status) => {
      // The default policy would spend three round trips on a phone's
      // connection re-asking a question already answered, and delay the error
      // state by seconds for a result that is identical every time.
      expect(shouldRetry(0, new ApiRequestError(status))).toBe(false)
    },
  )

  it('gives up after two attempts', () => {
    expect(shouldRetry(2, new ApiRequestError(500))).toBe(false)
  })
})

describe('isKycGateError', () => {
  it('recognises the 403 both routes answer for a non-approved user', () => {
    expect(isKycGateError(new ApiRequestError(403))).toBe(true)
  })

  it.each([[401], [404], [500]])('does not treat %i as the KYC gate', (status) => {
    // Only 403 means "you do not belong on this screen". Widening this would
    // bounce a user to /continue on an ordinary server fault.
    expect(isKycGateError(new ApiRequestError(status))).toBe(false)
  })

  it('is false for a transport failure', () => {
    expect(isKycGateError(new TypeError('Network request failed'))).toBe(false)
  })
})

describe('fetchRecipients', () => {
  it('unwraps the envelope and caps the list', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [{ id: 'r-1' }], nextCursor: null }))
    await expect(fetchRecipients()).resolves.toEqual([{ id: 'r-1' }])
    expect(mockFetch).toHaveBeenCalledWith('/v1/recipients?limit=50')
  })

  it('throws ApiRequestError carrying the status', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 403))
    // The status is what the retry policy and the KYC-gate check both branch
    // on, so it has to survive onto the error rather than be flattened to a
    // message string.
    await expect(fetchRecipients()).rejects.toMatchObject({ status: 403 })
  })
})

describe('fetchDestinations', () => {
  it('requests the destinations of the recipient it was given', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }))
    await fetchDestinations('r-9')
    expect(mockFetch).toHaveBeenCalledWith('/v1/recipients/r-9/destinations')
  })

  it('throws ApiRequestError carrying the status', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 500))
    await expect(fetchDestinations('r-9')).rejects.toMatchObject({ status: 500 })
  })
})
