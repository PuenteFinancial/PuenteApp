import type { Translations } from '../i18n/translations.js'

// Maps a failed recipient/destination write onto translated copy. API error
// strings are English-only and are never shown to a user raw.
//
// Sibling to apiError.ts rather than part of it: that module maps the envelope's
// stable `code` onto the `send.errors` namespace, while these routes are
// distinguished by HTTP status alone (the CLABE paths in
// apps/api/src/routes/v1/destinations.ts return four different statuses for what
// the user experiences as four different problems). Different input, different
// namespace, so they stay separate rather than growing one function with two
// modes.
//
// Type-only import of Translations, so this adds nothing to the runtime graph —
// which is what lets it sit in the root barrel while i18n itself does not.

type RecipientErrors = Translations['recipients']['errors']

export function errorKeyFor(status: number): keyof RecipientErrors {
  // 400 is only ever reached with a syntactically bad CLABE — the route
  // validates the check digit before it calls the provider.
  if (status === 400) return 'invalidClabe'
  if (status === 409) return 'alreadySaved'
  // 422 is the bank refusing an account that is well-formed but not real, which
  // the user can only fix by checking the number with their recipient.
  if (status === 422) return 'bankRejected'
  if (status === 502) return 'providerDown'
  return 'generic'
}
