import type { Lang } from '@/lib/translations'

// Block model for the Terms of Service documents.
//
// The terms outgrew the flat `s1..s6` shape the other legal pages still use:
// v1.1 has 22 sections, lettered subsections, ordered and unordered lists,
// grouped link lists, and inline links throughout. Modelling it as data means
// one renderer serves every version, including the frozen archives, and a
// future revision only touches a content file.

/** A run of text, or a link inside it. */
export type Inline = string | { text: string; href: string }

export type Block =
  /** Body paragraph. */
  | { k: 'p'; text: Inline[] }
  /** Emphasised callout, e.g. "This Section is important and time-sensitive." */
  | { k: 'note'; text: Inline[] }
  /** Bullet list. `lead` renders bold and inline, ahead of the body. */
  | { k: 'ul'; items: { lead?: string; text: Inline[] }[] }
  /** Numbered list, for sequences like the transfer steps in Section 5. */
  | { k: 'ol'; items: Inline[][] }
  /** Labelled groups of links, e.g. the partner terms in Section 4.1. */
  | { k: 'linkGroups'; groups: { label: string; links: { text: string; href: string }[] }[] }

export type Section = {
  h: string
  blocks: Block[]
  /** Lettered subsections, e.g. 4.1 / 4.2 / 4.3. */
  subs?: { h: string; blocks: Block[] }[]
}

export type TermsDoc = {
  title: string
  /** Effective date line shown under the title and in the PDF footer. */
  effective: string
  /** Machine-readable effective date. Doubles as the archive URL segment. */
  date: string
  version: string
  sections: Section[]
}

/** Chrome around the document: labels that are not part of the terms text. */
export type TermsChrome = {
  backHome: string
  jumpToEs: string
  downloadPdf: string
  priorVersionPre: string
  priorVersionLink: string
  archiveNoticePre: string
  archiveNoticeLink: string
  archiveNoticePost: string
}

export type TermsBundle = {
  chrome: Record<Lang, TermsChrome>
  doc: Record<Lang, TermsDoc>
}
