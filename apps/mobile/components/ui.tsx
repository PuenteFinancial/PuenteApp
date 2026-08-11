import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { ReactNode } from 'react'
import { colors, radii } from '@/lib/theme'

// The app's small set of shared primitives. Every colour and radius here comes
// from @puente/shared/theme — no literal hex anywhere in apps/mobile, which is
// the rule that keeps the mobile and web palettes from drifting.
//
// FONTS: intentionally system for now. The tokens name Bricolage Grotesque and
// Hanken Grotesk, but loading them needs expo-font plus bundled .ttf assets —
// an asset-pipeline change with its own EAS build to prove, which does not
// belong inside the first screens. Screens read `fonts` from the token module
// the moment that lands; nothing here hardcodes a family.

export function Screen({
  children,
  style,
  scroll = false,
}: {
  children: ReactNode
  style?: ViewStyle
  scroll?: boolean
}) {
  // `scroll` is load-bearing on the consent screen, not a nicety: the TCPA
  // string is ~330 characters and must render in full, unmodified, on the
  // smallest supported handset. Truncating or paraphrasing it to fit is
  // exactly what TCR rejected once already.
  if (scroll) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <ScrollView
          contentContainerStyle={[styles.screenInner, style]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          {children}
        </ScrollView>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={[styles.screenInner, style]}>{children}</View>
    </SafeAreaView>
  )
}

// The full-screen holding state, used wherever a screen is deciding where to
// send the user. No text on purpose: these resolve in well under a second on a
// warm session, and a message that flashes for 200ms reads as an error.
export function Loading() {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.hero} />
      </View>
    </SafeAreaView>
  )
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>
}

export function Heading({ children }: { children: ReactNode }) {
  return <Text style={styles.heading}>{children}</Text>
}

export function Body({ children }: { children: ReactNode }) {
  return <Text style={styles.body}>{children}</Text>
}

export function Caption({ children }: { children: ReactNode }) {
  return <Text style={styles.caption}>{children}</Text>
}

export function ErrorText({ children }: { children: ReactNode }) {
  // role="alert" so VoiceOver/TalkBack announce a failure the user did not
  // navigate to.
  return (
    <Text style={styles.error} accessibilityRole="alert">
      {children}
    </Text>
  )
}

export function Field({
  label,
  ...inputProps
}: { label: string } & Omit<TextInputProps, 'style' | 'placeholderTextColor'>) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.muted}
        accessibilityLabel={label}
        {...inputProps}
      />
    </View>
  )
}

export function Checkbox({
  checked,
  onToggle,
  children,
}: {
  checked: boolean
  onToggle: (next: boolean) => void
  children: ReactNode
}) {
  // React Native has no checkbox primitive. The whole row is the target — the
  // consent text is long, and a 20pt box is not a fair tap area for something
  // a user must affirmatively agree to.
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={() => onToggle(!checked)}
      style={styles.checkboxRow}
    >
      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
        {checked && <Text style={styles.checkboxMark}>✓</Text>}
      </View>
      <View style={styles.checkboxLabel}>{children}</View>
    </Pressable>
  )
}

export function ExternalLink({ label, url }: { label: string; url: string }) {
  // Opens in the system browser rather than an in-app WebView. CTIA web opt-in
  // requires the privacy policy and terms to be reachable from the point of
  // consent, and the pages that were vetted are the live site's — so this
  // points at those, not at a copy that could drift.
  return (
    <Text
      accessibilityRole="link"
      style={styles.link}
      onPress={() => {
        void Linking.openURL(url)
      }}
    >
      {label}
    </Text>
  )
}

export function Button({
  label,
  onPress,
  disabled = false,
  variant = 'accent',
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  variant?: 'accent' | 'ghost'
}) {
  const ghost = variant === 'ghost'
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        ghost ? styles.buttonGhost : styles.buttonAccent,
        pressed && !disabled && styles.buttonPressed,
        disabled && styles.buttonDisabled,
      ]}
    >
      <Text style={[styles.buttonLabel, ghost && styles.buttonLabelGhost]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.body,
  },
  screenInner: {
    flex: 1,
    paddingHorizontal: 20,
    paddingVertical: 24,
    gap: 16,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 20,
    gap: 12,
  },
  heading: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: colors['ink-2'],
  },
  caption: {
    fontSize: 13,
    lineHeight: 20,
    color: colors.muted,
  },
  error: {
    fontSize: 13,
    lineHeight: 20,
    color: colors.error,
  },
  button: {
    borderRadius: radii.btn,
    paddingVertical: 16,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  buttonAccent: {
    backgroundColor: colors.accent,
  },
  buttonGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.line,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonLabel: {
    fontSize: 17,
    fontWeight: '600',
    color: colors['accent-ink'],
  },
  buttonLabelGhost: {
    color: colors['ink-2'],
  },
  field: {
    gap: 6,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors['ink-2'],
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.sm,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 17,
    color: colors.ink,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 4,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: radii.btn,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  checkboxChecked: {
    backgroundColor: colors.accent,
    borderColor: colors['accent-2'],
  },
  checkboxMark: {
    fontSize: 15,
    fontWeight: '700',
    color: colors['accent-ink'],
  },
  checkboxLabel: {
    flex: 1,
  },
  link: {
    color: colors.hero,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
})
