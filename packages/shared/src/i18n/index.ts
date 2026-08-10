// Entry point for `@puente/shared/i18n`. Deliberately NOT re-exported from the
// root barrel: apps/api has @puente/shared as a runtime dependency, and tsup
// leaves it external, so anything in the root entry gets evaluated at every API
// and worker boot. 1,300 lines of UI copy has no business in that path.
export * from './translations.js'
