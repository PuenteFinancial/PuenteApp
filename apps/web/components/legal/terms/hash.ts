import { createHash } from 'node:crypto'
import { termsEn, termsEs } from './v2026-08-29'

/**
 * Fingerprint of the terms content that the PDF is generated from.
 *
 * The generator writes this value to pdf.hash alongside the PDF. A unit test
 * recomputes it and fails if the committed hash no longer matches, which is
 * what catches a content edit that shipped without regenerating the PDF.
 * Hashing the data (rather than the PDF bytes) keeps the check browser-free,
 * so it runs in the existing CI job and stays deterministic.
 */
export function termsContentHash(): string {
  return createHash('sha256')
    .update(JSON.stringify({ en: termsEn, es: termsEs }))
    .digest('hex')
}
