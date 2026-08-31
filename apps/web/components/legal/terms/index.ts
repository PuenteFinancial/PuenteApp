import type { Lang } from '@/lib/translations'
import type { TermsChrome, TermsDoc } from './types'
import { termsEn, termsEs } from './v2026-08-29'
import { termsV1En, termsV1Es } from './v2026-07-21'

export * from './types'

/** The Terms of Service currently in effect. */
export const currentTerms: Record<Lang, TermsDoc> = { en: termsEn, es: termsEs }

/**
 * Superseded versions, newest first. Each is served at /terms/<date> and
 * linked from the current terms so a user can read what they agreed to.
 */
export const archivedTerms: Record<string, Record<Lang, TermsDoc>> = {
  '2026-07-21': { en: termsV1En, es: termsV1Es },
}

/** Filename of the generated bilingual PDF, served from /public. */
export const TERMS_PDF = '/puente-terms-of-service.pdf'

export const termsChrome: Record<Lang, TermsChrome> = {
  en: {
    backHome: '← Back to home',
    jumpToEs: 'Español ↓',
    downloadPdf: 'Download PDF (English and Spanish)',
    priorVersionPre: 'Previous version:',
    priorVersionLink: 'July 21, 2026',
    archiveNoticePre: 'This version is no longer in effect. See the',
    archiveNoticeLink: 'current Terms of Service',
    archiveNoticePost: '.',
  },
  es: {
    backHome: '← Volver al inicio',
    jumpToEs: 'English ↑',
    downloadPdf: 'Descargar PDF (inglés y español)',
    priorVersionPre: 'Versión anterior:',
    priorVersionLink: '21 de julio de 2026',
    archiveNoticePre: 'Esta versión ya no está vigente. Consulte los',
    archiveNoticeLink: 'Términos de Servicio vigentes',
    archiveNoticePost: '.',
  },
}
