// Shared inline styles for the ops board's controls (ops board slice 1).
// buttonStyle/inputStyle were copied verbatim into three components before
// the detail page would have made it four; one definition now.
import type { CSSProperties } from 'react'

export function buttonStyle(variant: 'primary' | 'secondary', disabled = false): CSSProperties {
  return {
    fontSize: 13,
    fontWeight: 600,
    padding: '6px 14px',
    borderRadius: 'var(--r-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    border: variant === 'primary' ? '1px solid var(--hero)' : '1px solid var(--line-2)',
    background: variant === 'primary' ? 'var(--hero)' : 'transparent',
    color: variant === 'primary' ? 'var(--surface)' : 'inherit',
  }
}

export function inputStyle(invalid = false): CSSProperties {
  return {
    display: 'block',
    width: '100%',
    marginTop: 4,
    padding: '6px 8px',
    fontFamily: 'var(--mono)',
    fontSize: 13,
    border: `1px solid ${invalid ? 'var(--color-error)' : 'var(--line-2)'}`,
    borderRadius: 'var(--r-sm)',
    background: 'var(--surface-2)',
    color: 'inherit',
  }
}
