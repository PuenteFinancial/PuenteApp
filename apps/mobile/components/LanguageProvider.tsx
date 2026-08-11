import { translations, type Lang, type Translations } from '@puente/shared/i18n'
import * as SecureStore from 'expo-secure-store'
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

type LanguageContextValue = {
  lang: Lang
  setLang: (lang: Lang) => void
  t: Translations
}

const LanguageContext = createContext<LanguageContextValue | null>(null)

const STORAGE_KEY = 'puente.lang'

// expo-secure-store rather than AsyncStorage, which is the ordinary home for a
// preference like this. Not because a language choice is sensitive — it plainly
// is not — but because AsyncStorage is another native module to add, link and
// validate against RN 0.86, and secure-store is already in the tree for the
// session. Two characters in the keychain costs nothing. If a second
// non-sensitive preference ever appears, that is the moment to add AsyncStorage
// and move both.
//
// Deliberately NOT defaulted from the device locale: the web app defaults every
// visitor to Spanish (apps/web/components/LanguageProvider.tsx), and the user
// this app is built for often carries a phone set to English. Matching web is
// the known-correct behaviour; device-locale detection is a product decision,
// not an implementation detail to slip in here.
const DEFAULT_LANG: Lang = 'es'

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(DEFAULT_LANG)
  const [ready, setReady] = useState(false)

  // The stored choice can only be read asynchronously, so the first frame would
  // otherwise render Spanish and then snap to English for a user who chose it.
  // Nothing renders until this resolves, and the caller keeps the splash screen
  // up meanwhile — so there is no flash to see.
  useEffect(() => {
    let cancelled = false
    SecureStore.getItemAsync(STORAGE_KEY)
      .then((stored) => {
        if (cancelled) return
        if (stored === 'en' || stored === 'es') setLangState(stored)
      })
      .catch(() => {
        // A keychain read failure is not worth blocking sign-in over; the
        // default is a valid language.
      })
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setLang = useCallback((next: Lang) => {
    // State first: the toggle must feel instant, and a failed keychain write
    // should cost the user their preference next launch, not this tap.
    setLangState(next)
    void SecureStore.setItemAsync(STORAGE_KEY, next).catch(() => {})
  }, [])

  if (!ready) return null

  return (
    <LanguageContext.Provider value={{ lang, setLang, t: translations[lang] }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLanguage must be used inside LanguageProvider')
  return ctx
}
