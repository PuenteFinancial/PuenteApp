// Entry point for `@puente/shared/theme`. Kept separate from the root barrel
// because tailwind.config.js is CommonJS and must `require()` it — this is the
// only entry that ships a .cjs build.
export * from './tokens.js'
