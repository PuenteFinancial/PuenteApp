// Moved to @puente/shared/i18n so apps/mobile renders the same strings from the
// same source. This shim keeps the ~10 `@/lib/translations` import sites in
// place — the seam lives here, not spread across every component.
//
// Value and type are exported separately on purpose: apps/web sets
// `isolatedModules`, under which re-exporting a type through the value form
// (`export { Translations }`) is an error.
export { translations } from '@puente/shared/i18n'
export type { Lang, Translations } from '@puente/shared/i18n'
