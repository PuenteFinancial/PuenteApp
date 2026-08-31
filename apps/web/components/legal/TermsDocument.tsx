import Link from 'next/link'
import type { Block, Inline, Section, TermsDoc } from './terms'
import { TERMS_PDF, termsChrome } from './terms'

// Renders a Terms of Service document. Both languages are rendered inline on
// one page rather than behind a toggle, so the canonical /terms URL always
// SSRs the English text (which is legally operative and is what the A2P 10DLC
// vetting scanner reads) while a Spanish reader never has to find a control.
//
// The same renderer serves the current terms and every frozen archive, so a
// superseded version keeps rendering correctly without a copy of the markup.

function renderInline(text: Inline[]) {
  return text.map((part, i) => {
    if (typeof part === 'string') return <span key={i}>{part}</span>
    const external = part.href.startsWith('http')
    return external ? (
      <a
        key={i}
        href={part.href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 hover:underline break-words"
      >
        {part.text}
      </a>
    ) : (
      <Link key={i} href={part.href} className="text-blue-600 hover:underline break-words">
        {part.text}
      </Link>
    )
  })
}

function renderBlock(block: Block, i: number) {
  switch (block.k) {
    case 'p':
      return <p key={i}>{renderInline(block.text)}</p>
    case 'note':
      return (
        <p key={i} className="font-semibold text-gray-900">
          {renderInline(block.text)}
        </p>
      )
    case 'ul':
      return (
        <ul key={i} className="list-disc pl-6 space-y-2">
          {block.items.map((item, j) => (
            <li key={j}>
              {item.lead ? <strong className="text-gray-900">{item.lead} </strong> : null}
              {renderInline(item.text)}
            </li>
          ))}
        </ul>
      )
    case 'ol':
      return (
        <ol key={i} className="list-decimal pl-6 space-y-2">
          {block.items.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </ol>
      )
    case 'linkGroups':
      return (
        <div key={i} className="space-y-4">
          {block.groups.map((group, j) => (
            <div key={j}>
              <p className="font-semibold text-gray-900 mb-1">{group.label}</p>
              <ul className="list-disc pl-6 space-y-1">
                {group.links.map((link, k) => (
                  <li key={k}>
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline break-words"
                    >
                      {link.text}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )
  }
}

function renderSection(section: Section, i: number) {
  return (
    <section key={i}>
      <h3 className="text-xl font-semibold text-gray-900 mb-3">{section.h}</h3>
      <div className="space-y-4">{section.blocks.map(renderBlock)}</div>
      {section.subs?.map((sub, j) => (
        <div key={j} className="mt-6">
          <h4 className="text-base font-semibold text-gray-900 mb-2">{sub.h}</h4>
          <div className="space-y-4">{sub.blocks.map(renderBlock)}</div>
        </div>
      ))}
    </section>
  )
}

type Props = {
  doc: TermsDoc
  lang: 'en' | 'es'
  /** Anchor id, used as the jump-link target between the two languages. */
  id: string
  /** Where the cross-language jump link points. */
  jumpHref: string
  /** Date segment of the version this one superseded, if any. */
  priorVersion?: string
  /** Set on archived versions to render the superseded banner. */
  archived?: boolean
}

export default function TermsDocument({ doc, lang, id, jumpHref, priorVersion, archived }: Props) {
  const c = termsChrome[lang]

  return (
    <article id={id} className="scroll-mt-8">
      <div className="flex items-baseline justify-between gap-4 mb-2">
        <h2 className="text-3xl font-bold text-gray-900">{doc.title}</h2>
        <a href={jumpHref} className="text-sm text-blue-600 hover:underline shrink-0">
          {c.jumpToEs}
        </a>
      </div>
      <p className="text-sm text-gray-500">{doc.effective}</p>

      {archived ? (
        <p className="mt-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {c.archiveNoticePre}{' '}
          <Link href="/terms" className="underline">
            {c.archiveNoticeLink}
          </Link>
          {c.archiveNoticePost}
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <a href={TERMS_PDF} download className="text-blue-600 hover:underline">
            {c.downloadPdf}
          </a>
          {priorVersion ? (
            <span className="text-gray-500">
              {c.priorVersionPre}{' '}
              <Link href={`/terms/${priorVersion}`} className="text-blue-600 hover:underline">
                {c.priorVersionLink}
              </Link>
            </span>
          ) : null}
        </div>
      )}

      <div className="prose prose-gray max-w-none mt-10 space-y-8 text-gray-700 leading-relaxed">
        {doc.sections.map(renderSection)}
      </div>
    </article>
  )
}
