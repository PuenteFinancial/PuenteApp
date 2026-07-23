import { defineConfig, devices } from '@playwright/test'

// First e2e harness in the repo. It runs the real Next app against a small
// mock-API fixture (e2e/mock-api.mjs) standing in for the Fastify API, so the
// send flow can be driven end-to-end with no real backend, DB, or auth server.
const MOCK_API_PORT = 4319
const WEB_PORT = 3100
const BASE_URL = `http://localhost:${WEB_PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  timeout: 30_000,
  use: { baseURL: BASE_URL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/mock-api.mjs',
      port: MOCK_API_PORT,
      reuseExistingServer: !process.env.CI,
      env: { MOCK_API_PORT: String(MOCK_API_PORT) },
    },
    {
      command: `next dev -p ${WEB_PORT}`,
      port: WEB_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        // Point the web proxies at the mock API; blank the PostHog token so the
        // web-send-money flag resolves to its safe fallback (visible in dev).
        INTERNAL_API_URL: `http://localhost:${MOCK_API_PORT}`,
        NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: '',
      },
    },
  ],
})
