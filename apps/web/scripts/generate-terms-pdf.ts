/**
 * Generates the bilingual Terms of Service PDF from the same content the
 * /terms page renders, so the two can never disagree.
 *
 *   pnpm --filter @puente/web run terms:pdf
 *
 * Requires a Chromium build: `npx playwright install chromium`.
 *
 * The PDF is committed. `terms-pdf.test.ts` recomputes the content hash and
 * fails if it drifts from the committed hash, which is what stops a content
 * edit from shipping with a stale PDF. That check is a plain unit test on
 * purpose: it needs no browser, so it runs in the existing CI job.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { Block, Inline, TermsDoc } from '../components/legal/terms/types'
import { termsEn, termsEs } from '../components/legal/terms/v2026-08-29'
import { termsContentHash } from '../components/legal/terms/hash'

const OUT_PDF = join(import.meta.dirname, '../public/puente-terms-of-service.pdf')
const OUT_HASH = join(import.meta.dirname, '../components/legal/terms/pdf.hash')

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * In print there is nothing to click, so a link's destination has to survive
 * as text. Partner terms are incorporated by reference via those URLs, so
 * dropping them would weaken the document.
 */
function inlineToHtml(text: Inline[]): string {
  return text
    .map((part) => {
      if (typeof part === 'string') return esc(part)
      if (part.href.startsWith('mailto:')) return esc(part.text)
      if (part.text === part.href) return esc(part.text)
      return `${esc(part.text)} <span class="url">(${esc(part.href)})</span>`
    })
    .join('')
}

function blockToHtml(block: Block): string {
  switch (block.k) {
    case 'p':
      return `<p>${inlineToHtml(block.text)}</p>`
    case 'note':
      return `<p class="note">${inlineToHtml(block.text)}</p>`
    case 'ul':
      return `<ul>${block.items
        .map(
          (i) =>
            `<li>${i.lead ? `<strong>${esc(i.lead)}</strong> ` : ''}${inlineToHtml(i.text)}</li>`,
        )
        .join('')}</ul>`
    case 'ol':
      return `<ol>${block.items.map((i) => `<li>${inlineToHtml(i)}</li>`).join('')}</ol>`
    case 'linkGroups':
      return block.groups
        .map(
          (g) =>
            `<p class="group-label">${esc(g.label)}</p><ul>${g.links
              .map(
                (l) =>
                  `<li>${esc(l.text)} <span class="url">(${esc(l.href)})</span></li>`,
              )
              .join('')}</ul>`,
        )
        .join('')
  }
}

function docToHtml(doc: TermsDoc): string {
  const sections = doc.sections
    .map((s) => {
      const subs = (s.subs ?? [])
        .map((sub) => `<h3>${esc(sub.h)}</h3>${sub.blocks.map(blockToHtml).join('')}`)
        .join('')
      return `<section><h2>${esc(s.h)}</h2>${s.blocks.map(blockToHtml).join('')}${subs}</section>`
    })
    .join('')
  return `<h1>${esc(doc.title)}</h1><p class="effective">${esc(doc.effective)}</p>${sections}`
}

// Deliberately plain: black on white, no logo, no brand colour, no link
// colour. Just enough hierarchy to stay legible in print.
const CSS = `
  @page { size: Letter; margin: 20mm 18mm 18mm; }
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; font-size: 10pt; line-height: 1.5;
         color: #000; background: #fff; margin: 0; }
  h1 { font-size: 17pt; margin: 0 0 4pt; }
  h2 { font-size: 12pt; margin: 16pt 0 4pt; page-break-after: avoid; }
  h3 { font-size: 10.5pt; margin: 10pt 0 3pt; page-break-after: avoid; }
  p, li { margin: 0 0 6pt; orphans: 3; widows: 3; }
  ul, ol { margin: 0 0 6pt; padding-left: 16pt; }
  .effective { color: #444; margin-bottom: 14pt; }
  .note { font-weight: bold; }
  .group-label { font-weight: bold; margin-bottom: 2pt; }
  .url { color: #444; word-break: break-all; }
  section { page-break-inside: auto; }
  .lang-break { page-break-before: always; }
`

async function main() {
  const html = `<!doctype html><html><head><meta charset="utf-8">
    <title>Puente Financial Terms of Service</title><style>${CSS}</style></head>
    <body>${docToHtml(termsEn)}<div class="lang-break">${docToHtml(termsEs)}</div></body></html>`

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'load' })
    await page.pdf({
      path: OUT_PDF,
      format: 'Letter',
      printBackground: false,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `<div style="width:100%;font-family:Helvetica,Arial,sans-serif;font-size:7pt;color:#444;padding:0 18mm;display:flex;justify-content:space-between;">
        <span>Puente Financial, Inc. Terms of Service v${termsEn.version}, effective ${termsEn.date}</span>
        <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
      </div>`,
      margin: { top: '20mm', bottom: '18mm', left: '18mm', right: '18mm' },
    })
  } finally {
    await browser.close()
  }

  writeFileSync(OUT_HASH, `${termsContentHash()}\n`, 'utf8')
  console.log(`Wrote ${OUT_PDF}`)
  console.log(`Wrote ${OUT_HASH}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
