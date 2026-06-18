import { Translations } from '@/lib/translations'

type Props = { t: Translations['phone'] }

const CHART_PTS: [number, number][] = [
  [8, 72], [55, 63], [102, 54], [149, 43], [196, 34], [243, 24], [286, 13],
]
const LINE = CHART_PTS.map((p) => p.join(',')).join(' ')
const AREA = `M${CHART_PTS[0][0]},88 L${LINE} L${CHART_PTS[6][0]},88 Z`

export default function CreditPhoneUI({ t }: Props) {
  return (
    <div className="cphone">
      <div className="cphone-notch" />
      <div className="cphone-screen">
        <div className="cp-top">
          <div className="cp-hi">{t.greeting} <b>{t.name}</b></div>
          <div className="cp-avatar">M</div>
        </div>

        <div className="cp-score">
          <div className="cp-score-head">
            <div>
              <div className="cp-score-lab">{t.scoreLabel}</div>
              <div className="cp-score-num">712</div>
            </div>
            <span className="cp-delta">{t.delta}</span>
          </div>
          <svg viewBox="0 0 300 92" width="100%" height="84" style={{ display: 'block', marginTop: 4 }}>
            <defs>
              <linearGradient id="cpFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#B7E64C" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#B7E64C" stopOpacity={0} />
              </linearGradient>
            </defs>
            <path d={AREA} fill="url(#cpFill)" />
            <polyline points={LINE} fill="none" stroke="#B7E64C" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx={CHART_PTS[6][0]} cy={CHART_PTS[6][1]} r="6.5" fill="#B7E64C" stroke="#3D6B55" strokeWidth="2.5" />
          </svg>
        </div>

        <div className="cp-remit">
          <div className="cp-remit-head">
            <span className="cp-remit-lab">{t.remitLabel}</span>
            <span className="cp-remit-note">{t.remitNote}</span>
          </div>
          {t.sends.map((s, i) => (
            <div key={i} className="cp-row">
              <span className="ti">↗</span>
              <div className="tt">
                <b>{s.who}</b>
                <small>{t.reported}</small>
              </div>
              <div className="tv">
                <b>{s.amt}</b>
                <small>{t.onTime}</small>
              </div>
            </div>
          ))}
        </div>

        <div className="cp-cta">
          <div>{t.cta}</div>
        </div>
      </div>
    </div>
  )
}
