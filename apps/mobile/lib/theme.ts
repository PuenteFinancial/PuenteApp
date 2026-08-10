// The app's design tokens, re-exported from @puente/shared/theme so screens
// import from one place and the web/mobile palette cannot drift.
//
// WHY StyleSheet AND NOT NATIVEWIND (decided 2026-08-10, docs/prds/mobile-mvp.md §3):
// NativeWind 4.2.6's engine, react-native-css-interop@0.2.6, declares a
// NON-optional peer on react-native-reanimated >=3.6.2 (its peerDependenciesMeta
// marks react-native-svg and react-native-safe-area-context optional, but not
// reanimated). Three things made that a bad trade here:
//
//   1. reanimated is not currently in apps/mobile's tree at all — only in the
//      pnpm store as an unlinked peer of transitive packages. Adopting NativeWind
//      means adding it AND react-native-worklets as real native dependencies.
//   2. No EAS build has ever run against this app. The first native build would
//      be exercising the app and two new native modules simultaneously.
//   3. css-interop 0.2.6 targets the reanimated 3 era; Expo SDK 57 ships
//      reanimated 4, which moved worklets into a separate package. The semver
//      range still matches, so this would resolve cleanly, bundle cleanly in
//      Metro, and only surface in a native build.
//
// Revisit when NativeWind v5 (currently 5.0.0-preview) is stable — it targets
// the newer RN/Tailwind line. Nothing here blocks that: screens consume tokens
// through this module, not a styling library.

export { colors, radii, fonts } from '@puente/shared/theme'
export type { ColorToken, RadiusToken, FontToken } from '@puente/shared/theme'
