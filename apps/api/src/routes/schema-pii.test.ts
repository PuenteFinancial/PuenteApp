import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { relayBodySchema, relayResponseSchema } from './v1/bridge-customer.js'

// Invariants (a) + (b) of the K6 custody rule (2026-09-03): identity numbers
// cross exactly ONE route's request schema, are never in a response schema,
// and are never a column. The 2026-08-27 rule ("a test must prove no such
// field exists in any API schema") was convention until now — the web guard
// in apps/web/lib/cryptoPayStep.test.ts claimed this API half existed.
//
// The scan is deliberately over ALL text of every route file (comments
// included): a comment that names the field in a second route is already a
// sign the invariant is drifting. Migrations strip `--` comments because a
// column comment may legitimately say "never store DOB".

const ROUTES_DIR = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(ROUTES_DIR, '..', '..', '..', '..', 'supabase', 'migrations')

export const IDENTITY_TOKEN =
  /\b(dob|taxId|ssn|itin|birth_date|date_of_birth|identifying_information|tax_identification)\b/

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return walk(full)
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : []
  })
}

describe('identity fields on the API wire', () => {
  it('(a) exactly one route file names them — the relay — and only in its request body', () => {
    const matches = walk(ROUTES_DIR)
      .filter((file) => IDENTITY_TOKEN.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROUTES_DIR, file))
      .sort()
    expect(matches).toEqual(['v1/bridge-customer.ts'])

    expect(Object.keys(relayBodySchema.properties)).toEqual(['dob', 'taxId'])
    expect(Object.keys(relayBodySchema.properties.taxId.properties)).toEqual(['type', 'number'])
    expect(relayBodySchema.additionalProperties).toBe(false)
    expect(JSON.stringify(relayResponseSchema)).not.toMatch(IDENTITY_TOKEN)
  })

  it('(b) no migration defines a column for them', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'))
    expect(files.length).toBeGreaterThan(20)
    const offenders = files.filter((name) => {
      const ddl = readFileSync(join(MIGRATIONS_DIR, name), 'utf8')
        .split('\n')
        .map((line) => line.replace(/--.*$/, ''))
        .join('\n')
      return IDENTITY_TOKEN.test(ddl)
    })
    expect(offenders).toEqual([])
  })

  it('the token list itself covers the relay body and Bridge wire names', () => {
    for (const token of ['dob', 'taxId', 'ssn', 'itin', 'birth_date', 'identifying_information']) {
      expect(IDENTITY_TOKEN.test(token), token).toBe(true)
    }
  })
})
