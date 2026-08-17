import { describe, it, expect } from 'vitest'
import { errorKeyFor } from './recipientErrors.js'

// The statuses here are not arbitrary — each is one the CLABE routes actually
// return (apps/api/src/routes/v1/destinations.ts). If a route starts returning
// a new one, `generic` is the safe landing and this suite is where that shows.
describe('errorKeyFor', () => {
  it.each([
    [400, 'invalidClabe'],
    [409, 'alreadySaved'],
    [422, 'bankRejected'],
    [502, 'providerDown'],
  ] as const)('maps %i onto %s', (status, key) => {
    expect(errorKeyFor(status)).toBe(key)
  })

  it.each([[401], [403], [404], [500], [503], [0]])(
    'falls back to generic for %i',
    (status) => {
      // Never leak an unmapped status as a missing string — a user seeing
      // "undefined" is worse than a vague but translated message.
      expect(errorKeyFor(status)).toBe('generic')
    },
  )
})
