import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

type SignupPhoneContextValue = {
  phone: string | null
  setPhone: (phone: string | null) => void
}

const SignupPhoneContext = createContext<SignupPhoneContextValue | null>(null)

/**
 * Carries the normalized phone number from the sign-in screen to the verify
 * screen, and no further.
 *
 * Deliberately React state, not storage and not a route param:
 *
 *   - **Not secure-store / AsyncStorage.** A phone number is PII with a useful
 *     life of about sixty seconds here. Writing it to disk to survive a
 *     navigation the user is actively performing trades a real, persistent
 *     disclosure risk for nothing. (Web uses sessionStorage, which has no
 *     mobile equivalent with the same lifetime — the closest options all
 *     outlive the flow.)
 *   - **Not a route param.** Params land in the URL, and PII in URLs is a
 *     project-wide rule, not a preference.
 *
 * The cost is that a cold mount of /verify — deep link, process death, fast
 * refresh — has no phone. That is handled explicitly there by routing back to
 * the start, mirroring apps/web/components/onboarding/OtpForm.tsx:19-26.
 */
export function SignupPhoneProvider({ children }: { children: ReactNode }) {
  const [phone, setPhone] = useState<string | null>(null)
  const value = useMemo(() => ({ phone, setPhone }), [phone])
  return <SignupPhoneContext.Provider value={value}>{children}</SignupPhoneContext.Provider>
}

export function useSignupPhone(): SignupPhoneContextValue {
  const ctx = useContext(SignupPhoneContext)
  if (!ctx) throw new Error('useSignupPhone must be used inside SignupPhoneProvider')
  return ctx
}
