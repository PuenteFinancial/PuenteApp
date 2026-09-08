'use client'

// The ops board's presentational primitives, lifted out of OpsOverviewView so
// the transfer detail page shares the exact visual language (ops board slice
// 1). Operator surface: dense, mono ids, tone-coded pills. Nothing here reads
// data or strings — every consumer passes labels in.
import type { BadgeTone } from '@/lib/transferState'

// Same tone → CSS-var map as TransferHistory's pill (kept local there too —
// lifting it is a broader refactor this admin page shouldn't drive).
export const TONE_COLOR: Record<BadgeTone, string> = {
  success: 'var(--hero)',
  progress: 'var(--accent-2)',
  neutral: 'var(--muted)',
  error: 'var(--color-error)',
}

export function Pill({ label, tone }: { label: string; tone: BadgeTone }) {
  return (
    <span
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: TONE_COLOR[tone],
        border: `1px solid ${TONE_COLOR[tone]}`,
        borderRadius: 999,
        padding: '2px 10px',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 10px' }}>{title}</h2>
      {children}
    </section>
  )
}

export function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--surface-2)',
        border: '1px solid var(--line-2)',
        borderRadius: 'var(--r-sm)',
        padding: '12px 14px',
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  )
}

// One label/value row inside a Card — the detail page is mostly these.
export function Row({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 12,
        fontSize: 13,
        padding: '3px 0',
      }}
    >
      <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontFamily: mono ? 'var(--mono)' : undefined, textAlign: 'right', wordBreak: 'break-all' }}>
        {children}
      </span>
    </div>
  )
}

export function Muted({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>{children}</p>
}

export const shortId = (id: string) => id.slice(0, 8)
