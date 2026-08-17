import { OTP_RESEND_COOLDOWN_SECONDS } from '@puente/shared'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { useLanguage } from '@/components/LanguageProvider'
import { useSignupPhone } from '@/components/SignupPhoneContext'
import { Body, Button, Caption, Card, ErrorText, Field, Heading, Screen } from '@/components/ui'
import { publicFetch } from '@/lib/api'
import { secureTokenStore } from '@/lib/auth/secureTokenStore'
import { isSessionResponse, tokensFromSession } from '@/lib/auth/types'

type Status = 'idle' | 'loading' | 'error' | 'resent' | 'rateLimited'

export default function Verify() {
  const { t } = useLanguage()
  const s = t.onboarding.verify
  const router = useRouter()
  const { phone, setPhone } = useSignupPhone()

  const [code, setCode] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [cooldown, setCooldown] = useState(OTP_RESEND_COOLDOWN_SECONDS)

  // "Did this screen open without a phone?" — captured once, at mount.
  //
  // Deliberately NOT a live read of `phone`. A successful verify clears the
  // number on purpose, and a live read cannot tell that apart from a cold
  // mount: it fires the guard below, which races `router.replace('/continue')`
  // and wins, dropping the user back on the sign-in screen with a perfectly
  // good session already in the keychain. That is what this looked like on the
  // simulator — verify returned 200 and /v1/users/me was never called.
  //
  // The cold-mount case this protects is real (deep link, process death, fast
  // refresh): the context is scoped to the (auth) layout and holds nothing.
  // There is no code to verify without a number, so start over rather than
  // render a form that cannot submit. Mirrors OtpForm.tsx:19-26 on web.
  const [mountedWithPhone] = useState(() => phone !== null)

  useEffect(() => {
    if (!mountedWithPhone) router.replace('/(auth)')
  }, [mountedWithPhone, router])

  // One interval for the life of the screen; `resend` restarts the count by
  // setting the number, not by re-arming a timer. The first cooldown starts on
  // mount, because the screen is only reached by a code having just been sent.
  useEffect(() => {
    const id = setInterval(() => {
      setCooldown((n) => (n > 0 ? n - 1 : 0))
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const verify = useCallback(async () => {
    if (!phone || status === 'loading') return
    setStatus('loading')

    try {
      const res = await publicFetch('/v1/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({ phone, token: code }),
      })
      const body: unknown = res.ok ? await res.json().catch(() => null) : null

      if (!isSessionResponse(body)) {
        // Covers both a rejected code (401) and a 200 whose body will not
        // parse. Neither is a usable session, and the user's next move is the
        // same either way.
        setStatus('error')
        return
      }

      await secureTokenStore.write(tokensFromSession(body, Date.now()))
      // Drop the number the moment it stops being needed.
      setPhone(null)
      // /continue re-derives the destination from the server — never assume a
      // verified user is a brand-new one.
      router.replace('/continue')
    } catch {
      setStatus('error')
    }
  }, [phone, code, status, setPhone, router])

  const resend = useCallback(async () => {
    if (!phone || cooldown > 0) return
    setCooldown(OTP_RESEND_COOLDOWN_SECONDS)

    try {
      const res = await publicFetch('/v1/auth/otp/send', {
        method: 'POST',
        // Consent was given on the screen that sent them here; the API pins
        // this to `const: true` and records the timestamp at verify.
        body: JSON.stringify({ phone, smsConsent: true }),
      })
      // 429 is its own state. `s.error` says the CODE did not work, which is
      // the wrong story for a send that was refused for being too soon — and
      // the misleading one, because it points the user at the digits they
      // typed rather than at the wait.
      if (res.ok) setStatus('resent')
      else setStatus(res.status === 429 ? 'rateLimited' : 'error')
    } catch {
      setStatus('error')
    }
  }, [phone, cooldown])

  if (!mountedWithPhone) return null

  return (
    <Screen scroll>
      <Card>
        <Heading>{s.title}</Heading>
        <Body>{s.sub}</Body>

        <Field
          label={s.code}
          value={code}
          onChangeText={(next) => setCode(next.replace(/\D/g, ''))}
          placeholder="123456"
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
        />

        <Button
          label={status === 'loading' ? s.verifying : s.cta}
          onPress={() => void verify()}
          disabled={status === 'loading' || code.length !== 6}
        />

        <Button
          label={cooldown > 0 ? s.resendIn(cooldown) : s.resend}
          onPress={() => void resend()}
          disabled={cooldown > 0 || status === 'loading'}
          variant="ghost"
        />

        {status === 'resent' && <Caption>{s.resent}</Caption>}
        {status === 'rateLimited' && <ErrorText>{t.send.errors.rate_limited}</ErrorText>}
        {status === 'error' && <ErrorText>{s.error}</ErrorText>}
      </Card>
    </Screen>
  )
}
