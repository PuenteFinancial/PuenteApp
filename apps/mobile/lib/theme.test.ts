import { describe, it, expect } from 'vitest'
import { colors, radii, fonts } from './theme.js'

// This suite is really a resolution test: it proves apps/mobile can reach
// @puente/shared/theme through the package's `exports` subpath. If the shared
// build or the exports map regresses, this fails here rather than at `expo
// start`, where the error surfaces as an opaque Metro resolver failure.
describe('theme tokens', () => {
  it('resolves the shared palette through the /theme subpath', () => {
    expect(colors.hero).toBe('#3D6B55')
    expect(colors.accent).toBe('#B7E64C')
    expect(colors.error).toBe('#d94f4f')
  })

  // React Native's borderRadius takes numbers, not "14px" strings — the shared
  // module stores them as numbers precisely so no call site has to strip a unit.
  it('exposes radii as numbers, ready for StyleSheet', () => {
    expect(radii.card).toBe(14)
    expect(typeof radii.sm).toBe('number')
    expect(typeof radii.btn).toBe('number')
  })

  it('names the three font families the app loads via expo-font', () => {
    expect(fonts.display).toBe('Bricolage Grotesque')
    expect(fonts.body).toBe('Hanken Grotesk')
    expect(fonts.mono).toBe('Space Mono')
  })
})
