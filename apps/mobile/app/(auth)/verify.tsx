import { useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { useLanguage } from '@/components/LanguageProvider'
import { useSignupPhone } from '@/components/SignupPhoneContext'
import { Body, Button, Caption, Card, ErrorText, Field, Heading, Screen } from '@/components/ui'
import { publicFetch } from '@/lib/api'
import { secureTokenStore } from '@/lib/auth/secureTokenStore'
import { isSessionResponse, tokensFromSession } from '@/lib/auth/types'

const RESEND_COOLDOWN_SECONDS = 30

type Status = 'idle' | 'loading' | 'error' | 'resent'

export default function Verify() {
  const { t } = useLanguage()
  const s = t.onboarding.verify
  const router = useRouter()
  const { phone, setPhone } = useSignupPhone()

  const [code, setCode] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS)

  // A cold mount has no phone — the context is scoped to the (auth) layout and
  // holds nothing after a deep link, process death or a fast refresh. There is
  // no code to verify without it, so start over rather than render a form that
  // cannot submit. Mirrors OtpForm.tsx:19-26 on web.
  useEffect(() => {
    if (!phone) router.replace('/(auth)')
  }, [phone, router])

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
    setCooldown(RESEND_COOLDOWN_SECONDS)

    try {
      const res = await publicFetch('/v1/auth/otp/send', {
        method: 'POST',
        // Consent was given on the screen that sent them here; the API pins
        // this to `const: true` and records the timestamp at verify.
        body: JSON.stringify({ phone, smsConsent: true }),
      })
      setStatus(res.ok ? 'resent' : 'error')
    } catch {
      setStatus('error')
    }
  }, [phone, cooldown])

  if (!phone) return null

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
        {status === 'error' && <ErrorText>{s.error}</ErrorText>}
      </Card>
    </Screen>
  )
}
