import * as SecureStore from 'expo-secure-store'
import type { TokenStore, Tokens } from './types.js'

// Keychain (iOS) / Keystore (Android) keys. Namespaced so they cannot collide
// with anything a library writes.
const ACCESS_KEY = 'puente.accessToken'
const REFRESH_KEY = 'puente.refreshToken'
const EXPIRES_KEY = 'puente.expiresAt'

// WHEN_UNLOCKED_THIS_DEVICE_ONLY, on both counts deliberately:
//   - WHEN_UNLOCKED: no background access to a session token while the phone
//     is locked; nothing here runs in the background.
//   - THIS_DEVICE_ONLY: excluded from encrypted iCloud/iTunes backups, so a
//     restore onto a second handset cannot carry a live money-moving session
//     with it. The user re-authenticates by SMS instead, which is the point.
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
}

// The only file in lib/auth that is not unit-tested — it is deliberately kept
// to thin get/set/delete calls with no branching worth asserting, so that the
// logic which DOES need testing (refresh sequencing, routing) sits behind the
// TokenStore interface and takes an in-memory implementation instead.
export const secureTokenStore: TokenStore = {
  async read(): Promise<Tokens | null> {
    const [accessToken, refreshToken, expiresAtRaw] = await Promise.all([
      SecureStore.getItemAsync(ACCESS_KEY, OPTIONS),
      SecureStore.getItemAsync(REFRESH_KEY, OPTIONS),
      SecureStore.getItemAsync(EXPIRES_KEY, OPTIONS),
    ])
    if (!accessToken || !refreshToken || !expiresAtRaw) return null

    const expiresAt = Number(expiresAtRaw)
    // A corrupt expiry would otherwise make every comparison false and leave
    // the app using a token it can never decide to refresh.
    if (!Number.isFinite(expiresAt)) return null

    return { accessToken, refreshToken, expiresAt }
  },

  async write(tokens: Tokens): Promise<void> {
    await Promise.all([
      SecureStore.setItemAsync(ACCESS_KEY, tokens.accessToken, OPTIONS),
      SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken, OPTIONS),
      SecureStore.setItemAsync(EXPIRES_KEY, String(tokens.expiresAt), OPTIONS),
    ])
  },

  async clear(): Promise<void> {
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_KEY, OPTIONS),
      SecureStore.deleteItemAsync(REFRESH_KEY, OPTIONS),
      SecureStore.deleteItemAsync(EXPIRES_KEY, OPTIONS),
    ])
  },
}
