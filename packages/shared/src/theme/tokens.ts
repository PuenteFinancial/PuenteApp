// The sage/lime design tokens, as plain data so every client can read them:
// NativeWind's tailwind.config.js (CommonJS, hence the .cjs build of this
// entry), React Native StyleSheet, and eventually the web.
//
// SOURCE OF TRUTH. `apps/web/app/globals.css:10-55` currently declares the same
// values as CSS custom properties and is a hand-maintained duplicate —
// regenerating those from this module is deliberately deferred so the mobile
// slice doesn't drag a web CSS refactor along with it (docs/prds/mobile-mvp.md
// §3). Until that lands, a palette change has to be made in both places.
//
// Note `apps/web/tailwind.config.ts` is NOT a third copy — it holds a stale
// navy/gold palette that no component references.

export const colors = {
  hero: '#3D6B55',
  'hero-2': '#335D49',
  'hero-3': '#2C5240',
  accent: '#B7E64C',
  'accent-2': '#A4D63E',
  'accent-ink': '#16291A',
  body: '#F4F2E9',
  surface: '#FFFFFF',
  'surface-2': '#FBFAF3',
  ink: '#16261D',
  'ink-2': '#39473F',
  muted: '#677A6F',
  line: '#E4E4D6',
  'line-2': '#EEEDE2',
  'on-hero': '#EFF5E7',
  error: '#d94f4f',
} as const

// Numbers, not "14px" strings: React Native's borderRadius takes numbers, and
// a Tailwind config can append the unit itself. The reverse conversion (px
// string → number) would have to happen at every RN call site.
export const radii = {
  card: 14,
  sm: 9,
  btn: 7,
} as const

// Family names only. Loading differs per platform — next/font on web,
// expo-font with bundled .ttf files on mobile.
export const fonts = {
  display: 'Bricolage Grotesque',
  body: 'Hanken Grotesk',
  mono: 'Space Mono',
} as const

export type ColorToken = keyof typeof colors
export type RadiusToken = keyof typeof radii
export type FontToken = keyof typeof fonts
