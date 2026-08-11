import { normalizePhone } from '@puente/shared'
import { useRouter } from 'expo-router'
import { useCallback, useState } from 'react'
import { useLanguage } from '@/components/LanguageProvider'
import { useSignupPhone } from '@/components/SignupPhoneContext'
import {
  Body,
  Button,
  Caption,
  Card,
  Checkbox,
  ErrorText,
  ExternalLink,
  Field,
  Heading,
  Screen,
} from '@/components/ui'
import { publicFetch } from '@/lib/api'

// The vetted pages, on the live site. Not in-app copies: A2P/TCR checked these
// URLs, and a second copy that drifts is a compliance problem rather than a
// stale-content one.
const PRIVACY_URL = 'https://www.puentefinancial.com/privacy'
const TERMS_URL = 'https://www.puentefinancial.com/terms'

/**
 * Sign-in / sign-up. One door: this same screen signs returning users in, which
 * is why the copy never says "create an account".
 *
 * A2P/TCR — LOAD-BEARING. `t.onboarding.signup.smsConsent` is quoted verbatim
 * in the Twilio campaign's `message_flow` field, and the campaign is registered
 * as 2FA only. A widened version was rejected with TCR error 30896. It renders
 * here unmodified — no truncation, no ellipsis, no small-screen paraphrase,
 * which is why this screen scrolls rather than compresses.
 */
export default function SignIn() {
  const { t } = useLanguage()
  const s = t.onboarding.signup
  const router = useRouter()
  const { setPhone } = useSignupPhone()

  const [input, setInput] = useState('')
  const [smsConsent, setSmsConsent] = useState(false)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')

  // TCPA: no SMS without affirmative consent. The API enforces this too — the
  // route's schema pins `smsConsent` to `const: true` — so this is the honest
  // surface of a server-side rule, not the rule itself.
  const canSubmit = smsConsent && input.trim().length > 0 && status !== 'loading'

  const submit = useCallback(async () => {
    if (!canSubmit) return
    setStatus('loading')

    const normalized = normalizePhone(input)

    try {
      const res = await publicFetch('/v1/auth/otp/send', {
        method: 'POST',
        body: JSON.stringify({ phone: normalized, smsConsent }),
      })
      if (!res.ok) {
        setStatus('error')
        return
      }
      // Held in memory for the verify screen only. Never written to disk and
      // never put in the route.
      setPhone(normalized)
      setStatus('idle')
      router.push('/(auth)/verify')
    } catch {
      setStatus('error')
    }
  }, [canSubmit, input, smsConsent, setPhone, router])

  return (
    <Screen scroll>
      <Card>
        <Heading>{s.title}</Heading>
        <Body>{s.sub}</Body>

        <Field
          label={s.phone}
          value={input}
          onChangeText={setInput}
          placeholder={s.phonePh}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          autoComplete="tel"
          autoFocus
        />

        <Checkbox checked={smsConsent} onToggle={setSmsConsent}>
          {/* Rendered whole and unmodified — see the A2P note above. */}
          <Caption>{s.smsConsent}</Caption>
        </Checkbox>

        {/* CTIA web opt-in: the privacy policy and terms must be reachable from
            the point of consent, and A2P/TCR vetting checks the opt-in surface
            for them. Do not remove. */}
        <Caption>
          {s.legal.pre} <ExternalLink label={s.legal.privacyLink} url={PRIVACY_URL} />{' '}
          {s.legal.and} <ExternalLink label={s.legal.termsLink} url={TERMS_URL} /> {s.legal.post}
        </Caption>

        <Button
          label={status === 'loading' ? s.sending : s.cta}
          onPress={() => void submit()}
          disabled={!canSubmit}
        />

        {status === 'error' && <ErrorText>{s.error}</ErrorText>}
      </Card>
    </Screen>
  )
}
