import type { RenderedDisclosure } from '@/lib/disclosure'

// The server-authored Reg E block, rendered VERBATIM. Shared by the review step
// (prepayment disclosure, above its accept/confirm controls) and the receipt
// view (below its receipt header) so the two can never drift. The web is not the
// source of this copy — it only lays it out; all wording comes from the API.
export default function DisclosureBody({ d }: { d: RenderedDisclosure }) {
  return (
    <div>
      <h2 style={{ fontFamily: 'var(--font)', fontSize: 17, fontWeight: 700, margin: '0 0 10px', color: 'var(--ink)' }}>
        {d.title}
      </h2>

      <ul
        style={{
          listStyle: 'none',
          margin: '0 0 12px',
          padding: '13px 15px',
          borderRadius: 'var(--r-sm)',
          background: 'var(--surface-2)',
          border: '1px solid var(--line-2)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {d.amountLines.map((line, i) => (
          <li key={i} style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink)' }}>
            {line}
          </li>
        ))}
        <li style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink)', marginTop: 4 }}>
          {d.fxRateLine}
        </li>
      </ul>

      {[d.cancellationRights, d.errorResolutionRights, d.wrongAccountWarning].map((para, i) => (
        <p key={i} style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.55, margin: '0 0 10px' }}>
          {para}
        </p>
      ))}
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 4px' }}>{d.contact}</p>
    </div>
  )
}
