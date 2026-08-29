import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { termsContentHash } from './hash'
import { currentTerms } from './index'

describe('terms PDF freshness', () => {
  it('committed PDF matches the current terms content', () => {
    const committed = readFileSync(join(import.meta.dirname, 'pdf.hash'), 'utf8').trim()
    expect(committed).toBe(termsContentHash())
  })
})

describe('terms content', () => {
  it('renders the same sections in both languages', () => {
    const en = currentTerms.en
    const es = currentTerms.es
    expect(es.sections).toHaveLength(en.sections.length)
    en.sections.forEach((section, i) => {
      expect(es.sections[i].subs?.length ?? 0).toBe(section.subs?.length ?? 0)
      expect(es.sections[i].blocks).toHaveLength(section.blocks.length)
    })
  })

  it('agrees on version and effective date across languages', () => {
    expect(currentTerms.es.version).toBe(currentTerms.en.version)
    expect(currentTerms.es.date).toBe(currentTerms.en.date)
  })
})
