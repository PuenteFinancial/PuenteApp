import { ImageResponse } from 'next/og'
import fs from 'fs'
import path from 'path'

export const alt = 'Puente Financial — Send money home. Build U.S. credit doing it.'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

// Two traps live in this loader, both learned from PR #222's preview builds:
//
// 1. turbopackIgnore keeps these REAL filesystem calls — without it, Next 16's
//    turbopack traces the whole project over the dynamic read and warns on
//    every build.
// 2. The returned ArrayBuffer must be sliced to THIS view's bytes. A Buffer is
//    a window into a possibly-shared ArrayBuffer, and bare `.buffer` hands
//    satori the whole slab from byte 0. Vercel prerenders all 38 pages in ONE
//    worker, so by the time this route renders, the slab can begin with an
//    earlier page's RSC flight payload — satori then dies with "Unsupported
//    OpenType signature 0:{" (the first bytes of RSC serialization). Local
//    builds use many workers and won the layout lottery, which is why this
//    only ever failed on Vercel.
function load(file: string): ArrayBuffer {
  const buf = fs.readFileSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ process.cwd(), file))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

export default function Image() {
  const displayData = load('public/fonts/BricolageGrotesque-Bold.ttf')
  const monoData = load('public/fonts/SpaceMono-Bold.ttf')

  return new ImageResponse(
    (
      <div
        style={{
          width: 1200,
          height: 630,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          background: '#2C5240',
          fontFamily: "'Bricolage Grotesque', sans-serif",
        }}
      >
        {/* Top row: logo lockup + pill */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {/* Arch mark */}
            <div style={{
              width: 48, height: 40,
              border: '4.5px solid #93C740',
              borderBottom: 'none',
              borderRadius: '28px 28px 0 0',
              position: 'relative',
              display: 'flex',
            }} />
            <span style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.03em', color: '#EFF5E7' }}>
              Puente
            </span>
          </div>
          <span style={{
            fontFamily: "'Space Mono', monospace",
            fontSize: 15, fontWeight: 700, letterSpacing: '0.16em',
            textTransform: 'uppercase', color: '#B7E64C',
            background: 'rgba(91,140,70,.14)',
            border: '1.5px solid rgba(91,140,70,.30)',
            padding: '10px 20px', borderRadius: 8,
            display: 'flex',
          }}>
            Remittances + Credit Building
          </span>
        </div>

        {/* Headline */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          <div style={{
            display: 'flex', flexDirection: 'column',
            fontSize: 96, fontWeight: 800,
            lineHeight: 0.96, letterSpacing: '-0.035em',
            color: '#EFF5E7',
          }}>
            <div style={{ display: 'flex' }}>
              <span>Send&nbsp;</span><span style={{ color: '#B7E64C' }}>money.</span>
            </div>
            <div style={{ display: 'flex' }}>
              <span>Build&nbsp;</span><span style={{ color: '#B7E64C' }}>credit.</span>
            </div>
          </div>
          <div style={{
            marginTop: 28, fontSize: 26, lineHeight: 1.45,
            color: 'rgba(239,245,231,0.74)',
            fontFamily: "'Bricolage Grotesque', sans-serif",
            fontWeight: 400,
            display: 'flex', maxWidth: 720,
          }}>
            Send money home at the real exchange rate — and build your U.S. credit history with every payment.
          </div>
        </div>

        {/* Bottom chips */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {[
            'Real exchange rate',
            'Works with your ITIN or SSN.',
            'Built for newcomers',
          ].map((label) => (
            <div key={label} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              fontSize: 18, fontWeight: 600,
              color: 'rgba(239,245,231,0.85)',
              background: 'rgba(255,255,255,0.07)',
              border: '1px solid rgba(239,245,231,0.14)',
              padding: '12px 20px', borderRadius: 8,
            }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#B7E64C' }} />
              {label}
            </div>
          ))}
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: 'Bricolage Grotesque', data: displayData, weight: 800, style: 'normal' },
        { name: 'Space Mono', data: monoData, weight: 700, style: 'normal' },
      ],
    }
  )
}
