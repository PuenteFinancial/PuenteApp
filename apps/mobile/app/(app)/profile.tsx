import { useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { useLanguage } from '@/components/LanguageProvider'
import {
  Body,
  Button,
  Caption,
  Card,
  ErrorText,
  Field,
  Heading,
  Loading,
  Screen,
} from '@/components/ui'
import { api } from '@/lib/api'
import type { MeResponse } from '@/lib/auth/types'
import { isValidProfile, NAME_MAX_LENGTH, toProfilePayload, type ProfileDraft } from '@/lib/profile'

const EMPTY: ProfileDraft = { firstName: '', lastName: '', email: '' }

/**
 * Legal name + email — everything Bridge needs before identity verification.
 *
 * The form loads its current values rather than starting blank. Web gets this
 * for free (its page is a server component that fetches /v1/users/me and passes
 * the values in, precisely so "returning users see their saved profile, not a
 * blank form that would overwrite it"). Mobile has no server component, so the
 * fetch happens here, on mount, behind a spinner.
 *
 * Fetching here rather than threading the user object down from /continue is
 * deliberate: this screen is reachable by deep link today and from a settings
 * entry later, and a screen that only works when entered from one direction is
 * a trap laid for the next person.
 */
export default function Profile() {
  const { t } = useLanguage()
  const s = t.onboarding.profile
  const router = useRouter()

  const [draft, setDraft] = useState<ProfileDraft>(EMPTY)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const res = await api.fetch('/v1/users/me')
        if (cancelled) return

        if (res.ok) {
          const user = (await res.json().catch(() => null)) as MeResponse | null
          if (cancelled) return
          if (user) {
            setDraft({
              firstName: user.firstName ?? '',
              lastName: user.lastName ?? '',
              email: user.email ?? '',
            })
          }
        }
        // A 404 legitimately means there is nothing saved yet — the verify
        // handler self-heals the row on the next sign-in. An empty form is the
        // correct rendering of that, not an error.
        setLoadState('ready')
      } catch {
        // Transport failure. Showing a blank form here would invite a returning
        // user to overwrite their saved name with whatever they retype.
        if (!cancelled) setLoadState('failed')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [attempt])

  const set = useCallback(
    (field: keyof ProfileDraft) => (value: string) => {
      setDraft((current) => ({ ...current, [field]: value }))
      // Clear a stale failure the moment the user starts fixing it.
      setSaveState((current) => (current === 'error' ? 'idle' : current))
    },
    [],
  )

  const save = useCallback(async () => {
    if (!isValidProfile(draft) || saveState === 'saving') return
    setSaveState('saving')

    try {
      const res = await api.fetch('/v1/users/me', {
        method: 'PATCH',
        body: JSON.stringify(toProfilePayload(draft)),
      })
      if (!res.ok) {
        setSaveState('error')
        return
      }
      // replace, not push: the form has been saved, and a back gesture landing
      // on it again would offer to re-submit values the server already has.
      router.replace('/(app)/kyc')
    } catch {
      setSaveState('error')
    }
  }, [draft, saveState, router])

  if (loadState === 'loading') return <Loading />

  if (loadState === 'failed') {
    return (
      <Screen>
        <Card>
          <ErrorText>{t.mobile.connection.error}</ErrorText>
          <Button
            label={t.mobile.connection.retry}
            onPress={() => {
              setLoadState('loading')
              setAttempt((n) => n + 1)
            }}
          />
        </Card>
      </Screen>
    )
  }

  return (
    <Screen scroll>
      <Card>
        <Heading>{s.title}</Heading>
        <Body>{s.sub}</Body>

        <Field
          label={s.firstName}
          value={draft.firstName}
          onChangeText={set('firstName')}
          autoComplete="given-name"
          textContentType="givenName"
          maxLength={NAME_MAX_LENGTH}
          autoCapitalize="words"
          autoFocus
        />

        <Field
          label={s.lastName}
          value={draft.lastName}
          onChangeText={set('lastName')}
          autoComplete="family-name"
          textContentType="familyName"
          maxLength={NAME_MAX_LENGTH}
          autoCapitalize="words"
        />

        <Field
          label={s.email}
          value={draft.email}
          onChangeText={set('email')}
          keyboardType="email-address"
          autoComplete="email"
          textContentType="emailAddress"
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Caption>{s.emailNote}</Caption>

        <Button
          label={saveState === 'saving' ? s.saving : s.cta}
          onPress={() => void save()}
          disabled={!isValidProfile(draft) || saveState === 'saving'}
        />

        {saveState === 'error' && <ErrorText>{s.error}</ErrorText>}
      </Card>
    </Screen>
  )
}
