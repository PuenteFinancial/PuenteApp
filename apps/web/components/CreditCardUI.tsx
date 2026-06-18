import React from 'react'

interface Props {
  variant?: 'sol' | 'mar' | 'ink'
  face?: 'front' | 'back'
  name?: string
  last4?: string
  tier?: string
  style?: React.CSSProperties
  className?: string
}

function Contactless() {
  return (
    <span className="contactless" aria-hidden="true">
      <i /><i /><i />
    </span>
  )
}

function NetMark() {
  return (
    <span className="netmark" aria-hidden="true">
      <i /><i />
    </span>
  )
}

function CardLogo() {
  return (
    <span className="brand" style={{ fontSize: 17 }}>
      <span className="arch" aria-hidden="true" />
      <span>Puente</span>
    </span>
  )
}

export default function CreditCardUI({
  variant = 'sol',
  face = 'front',
  name = 'MARÍA G. SANTOS',
  last4 = '4827',
  tier = 'Crédito',
  style,
  className = '',
}: Props) {
  if (face === 'back') {
    return (
      <div className={`ccard ccard--${variant} ccard--back ${className}`} style={style}>
        <div className="cc-stripe" />
        <div className="cc-sigwrap">
          <div className="cc-sig">
            <div className="cc-sigbar" />
            <div className="cc-cvv">{'•'.repeat(3)}</div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <CardLogo />
            <NetMark />
          </div>
          <p className="cc-fine">
            Puente Financial, Inc. Use of this card is subject to the cardholder agreement.<br />
            Lost or stolen? puente.com/help · +1 (888) 000-0000. Member FDIC.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={`ccard ccard--${variant} ${className}`} style={style}>
      <div className="cc-top">
        <CardLogo />
        <span className="cc-tier">{tier}</span>
      </div>
      <div className="cc-mid">
        <span className="chip" />
        <Contactless />
      </div>
      <div className="cc-num">5418&nbsp;&nbsp;••••&nbsp;&nbsp;••••&nbsp;&nbsp;{last4}</div>
      <div className="cc-bottom">
        <div>
          <span className="cc-label">Titular</span>
          <span className="cc-name">{name}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18 }}>
          <div>
            <span className="cc-label">Vence</span>
            <span className="cc-exp">08/29</span>
          </div>
          <NetMark />
        </div>
      </div>
      <div className="cc-roofs" aria-hidden="true">
        {Array.from({ length: 22 }).map((_, i) => (
          <i key={i} style={{ height: (10 + (i * 37) % 24) + 'px' }} />
        ))}
      </div>
    </div>
  )
}
