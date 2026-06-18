'use client'

import { useState, useEffect } from 'react'
import { useLanguage } from '@/components/LanguageProvider'
import { FX_RATE, FX_FEE } from '@/lib/fx'
import { COUNTRIES } from '@/lib/countries'

const CALC_COUNTRIES = COUNTRIES.filter((c) => c.inCalc)
const fmtInt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const usd = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const CHIPS = [100, 200, 500, 1000]

export default function Calculator() {
  const { t, lang } = useLanguage()
  const [amt, setAmt] = useState<number | ''>(200)
  const [rate, setRate] = useState(FX_RATE)
  const [country, setCountry] = useState(CALC_COUNTRIES[0])
  const c = t.remit.calc

  useEffect(() => {
    fetch(`/api/fx-rate?target=${country.currency}`)
      .then((r) => r.json())
      .then((d) => { if (typeof d.rate === 'number') setRate(d.rate) })
      .catch(() => {})
  }, [country])

  const numAmt = Number(amt) || 0
  const receive = Math.round(numAmt * rate)
  const total = numAmt + FX_FEE
  const [c1, c2, c3] = country.flagColors ?? ['var(--cielo)', '#fff', 'var(--mar)']

  return (
    <div className="calc">
      <div className="calc-to">
        <span className="flagdot">
          <i style={{ background: c1 }} />
          <i style={{ background: c2 }} />
          <i style={{ background: c3 }} />
        </span>
        <select
          className="calc-country-select"
          value={country.name.en}
          onChange={(e) => {
            const found = CALC_COUNTRIES.find((co) => co.name.en === e.target.value)
            if (found) setCountry(found)
          }}
          aria-label={c.to}
        >
          {CALC_COUNTRIES.map((co) => (
            <option key={co.name.en} value={co.name.en}>
              {lang === 'es' ? co.name.es : co.name.en}
            </option>
          ))}
        </select>
        <span className="lab">{c.to}</span>
      </div>

      <div className="calc-amt">
        <div style={{ flex: 1 }}>
          <span className="lab">{c.you}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 30, fontWeight: 700 }}>$</span>
            <input
              className="calc-input"
              type="number"
              inputMode="numeric"
              min="0"
              value={amt}
              onChange={(e) =>
                setAmt(e.target.value === '' ? '' : Math.max(0, Math.min(50000, Number(e.target.value))))
              }
              aria-label={c.you}
            />
          </div>
        </div>
        <span className="calc-cur">
          <span className="pip" />
          USD
        </span>
      </div>

      <input
        className="calc-slider"
        type="range"
        min="20"
        max="2000"
        step="10"
        value={Math.min(2000, numAmt)}
        onChange={(e) => setAmt(Number(e.target.value))}
        aria-label={c.you}
      />

      <div className="chips">
        {CHIPS.map((v) => (
          <button
            key={v}
            className={'chip-amt' + (numAmt === v ? ' is-active' : '')}
            onClick={() => setAmt(v)}
          >
            ${v}
          </button>
        ))}
      </div>

      <div className="calc-rate">
        <span className="ln" />
        <span>1 USD = {rate.toFixed(2)} {country.currency}</span>
        <span className="ln" />
      </div>

      <div className="calc-amt calc-amt--rcv">
        <div>
          <span className="lab">{c.they}</span>
          <span className="calc-out">{fmtInt.format(receive)}</span>
        </div>
        <span className="calc-cur">
          <span className="pip" />
          {country.currency}
        </span>
      </div>

      <div className="calc-foot">
        <span>{c.fee} <b>{c.flat}</b></span>
        <span>{c.total} <b>${usd.format(total)}</b></span>
      </div>
      <div className="calc-note">
        <span className="pip" />{c.note}
      </div>

      <a className="btn btn--accent" href="/signup">{c.cta}</a>
    </div>
  )
}
