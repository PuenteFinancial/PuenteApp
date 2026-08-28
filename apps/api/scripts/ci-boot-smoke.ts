// Boots the BUILT dist/*.js entrypoints (not src/ via tsx) against a stub env
// and asserts each reaches its own "ready" log line before exiting or timing
// out.
//
// Why this exists and typecheck/lint/test don't cover it: those all run
// against src/ through tsc's resolver or tsx, which uses Node's real per-file
// ESM loader — that loader tolerates certain circular-import orderings that
// tsup/esbuild's bundled, code-split output (server.ts + worker.ts share a
// chunk) does not. #255 was exactly this: a circular value import between
// services/funding/index.ts and stripe-onramp.ts was inert until K4 put a
// top-level `class X extends Y` inside the cycle — fine under tsx, but the
// bundler evaluated the subclass before its base class was initialized
// ("Class extends value undefined is not a constructor"). Every existing gate
// was green; only an actual bundled boot would have caught it. This is that
// gate.
//
// Usage (after `pnpm run build` / `pnpm turbo run build --filter=@puente/api`):
//   pnpm exec tsx scripts/ci-boot-smoke.ts

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const READY_TIMEOUT_MS = 15_000

// Minimal env satisfying config/env.ts's required (non-optional, no-default)
// fields, plus worker.ts's own required pair (optional in the shared schema
// so the API can boot without them; the worker asserts them itself). Values
// are shaped to pass Zod validation, not to be usable — nothing here needs to
// make a real network call before the ready line prints. DATABASE_URL and
// BRIDGE_TREASURY_WALLET_ID are fake on purpose: pg-boss's later connection
// attempt is expected to fail, and that's fine — it happens well after the
// module-evaluation window this script guards.
const STUB_ENV = {
  ...process.env,
  NODE_ENV: 'test',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SECRET_KEY: 'stub-secret-key',
  SUPABASE_PUBLISHABLE_KEY: 'stub-publishable-key',
  SUPABASE_JWKS_URL: 'http://127.0.0.1:54321/auth/v1/.well-known/jwks.json',
  DETAILS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  BRIDGE_API_KEY: 'stub-bridge-key',
  DATABASE_URL: 'postgres://stub:stub@127.0.0.1:5/stub',
  BRIDGE_TREASURY_WALLET_ID: 'stub-wallet-id',
  PORT: '0',
}

interface Target {
  name: string
  entry: string
  readyPattern: RegExp
}

const TARGETS: Target[] = [
  { name: 'server', entry: 'dist/server.js', readyPattern: /Server listening/ },
  { name: 'worker', entry: 'dist/worker.js', readyPattern: /health endpoint listening/ },
]

async function bootOne(target: Target): Promise<void> {
  const child = spawn(process.execPath, [target.entry], {
    env: STUB_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  let resolveReady: () => void
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  const onData = (chunk: Buffer) => {
    output += chunk.toString()
    if (target.readyPattern.test(output)) resolveReady()
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
  })

  const result = await Promise.race([
    readyPromise.then(() => 'ready' as const),
    exitPromise.then(() => 'exited' as const),
    delay(READY_TIMEOUT_MS).then(() => 'timeout' as const),
  ])

  child.kill('SIGKILL')

  if (result !== 'ready') {
    const reason = result === 'exited' ? 'exited before' : 'timed out waiting for'
    console.error(`✗ ${target.name} (${target.entry}) — ${reason} "${target.readyPattern}"`)
    console.error('--- captured output ---')
    console.error(output)
    throw new Error(`${target.name} boot smoke failed (${result})`)
  }

  console.log(`✓ ${target.name} (${target.entry}) reached "${target.readyPattern}"`)
}

async function main() {
  const failures: string[] = []
  for (const target of TARGETS) {
    try {
      await bootOne(target)
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err))
    }
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} target(s) failed boot smoke`)
    process.exit(1)
  }
}

await main()
