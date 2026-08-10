# PRD — Mobile MVP: React Native parity with the web dashboard

**Owner:** Joshua
**Build target:** Claude Code
**Goal:** A KYC-approved user can complete the entire remittance flow — sign in, verify identity,
add a recipient, get a quote, fund, track, and receive a receipt — from an iOS app, with no
capability the web dashboard has that the app lacks. **Definition of done:** one real send completed
end-to-end from a TestFlight build.

**Status (2026-08-10):** Not started. `apps/mobile` is a 15-file stub — two screens that `return
null` plus a Sentry init.

**Context:** `apps/web` is a complete remittance client (signup → onboarding/KYC → recipients →
quote → send → receipt → ops). The target users are mobile-first, so the app isn't optional; the
question was only when. Two things resolved on 2026-08-10:

1. **Twilio A2P was approved**, unblocking phone OTP — the app's front door, and until now a hard
   blocker on building any screen at all.
2. **The Apple long pole is the account, not the code.** Organization enrollment needs a D-U-N-S
   number (free, several business days) and is pure admin. It runs in parallel with everything here.

The API is already built for this: pure Bearer JWT, no cookies, no CSRF, `ALLOWED_ORIGINS` already
contains Expo's `:8081`. `docs/api-contract.md:7-9` says outright that the mobile client talks only
to this API. Nothing in this PRD requires an API redesign — but three slices need small, specific
API additions, called out where they land.

---

## 1. What we're building

Nine slices, ordered. M1–M2 are foundation and get a build into TestFlight (which starts the Apple
clock). M3–M7 are the parity port. M8–M9 are what an app needs that a web page doesn't.

1. **Foundation** — promote portable logic to `packages/shared`, design tokens, NativeWind. No
   user-visible change.
2. **Auth + shell** — phone OTP, secure-store tokens, refresh-on-401, post-sign-in routing.
3. **Profile + KYC handoff** — profile form, Bridge ToS → Persona via deep link, pending/rejected.
4. **Recipients + destinations** — recipient CRUD, CLABE double-entry confirm, archive. Establishes
   the client data layer.
5. **Quote + review + disclosure** — firm quote with countdown, Reg E prepayment disclosure, confirm.
6. **Pay** — `@stripe/stripe-react-native`, ACH via Financial Connections.
7. **Tracker + history + receipt + cancel** — polling tracker, cursor-paginated history, Reg E
   receipt, 30-min cancel.
8. **Push notifications** — device tokens + send service + client. Net-new on both sides.
9. **Store readiness** — EAS, icons, App Store metadata, privacy labels, Android parity check.

### Decisions locked (2026-08-10)

- **`packages/shared` becomes the home for portable logic, not just types.** This reverses the
  stance recorded at `apps/web/lib/transferState.ts:9-12` ("mirrored rather than imported"). Without
  it, mobile is a *third* hand-maintained copy of `TransferState`, error codes, and translations.
  Modules move slice-by-slice as a consumer appears, not in one big bang.
- **i18n: reuse `translations.ts` verbatim; rewrite the 42-line provider.** Not react-i18next —
  CLAUDE.md gets amended. `translations.ts` is plain data with no framework coupling, and its
  strings must stay character-identical to web for A2P/TCR reasons (see §4).
- **NativeWind + a shared token module.** NativeWind is *not* currently installed — only an orphaned
  `apps/mobile/nativewind-env.d.ts`. Web's real palette lives as CSS custom properties in
  `globals.css:10-55`, not in the stale `tailwind.config.ts`.
- **iOS first.** `app.json` already declares an Android package and the port is largely
  platform-agnostic, but MVP ships iOS; Android becomes a parity check in M9.
- **TanStack Query for the client data layer** (lands in M4, see §6). Web's server components
  *are* its data layer; mobile has no equivalent and needs one before recipients.
- **No ops console on mobile.** It's a desktop tool for one person.

### Where mobile diverges from web

These are not ports. Budget for them as new work:

| Concern | Web | Mobile |
|---|---|---|
| **Data layer** | Server components fetch + pass props | Client cache; every screen gains loading/error/empty states that don't exist today |
| **Session** | httpOnly cookies + a GET redirect handler | secure-store + 401 interceptor with single-flight refresh |
| **KYC return** | HTTP redirect to an allowlisted host | `expo-web-browser` auth session + `puente://` deep link — **needs an API change** |
| **Payment** | Stripe.js `PaymentElement` | `@stripe/stripe-react-native` + Financial Connections — different SDK |
| **Foreground detection** | `document.visibilitychange` | `AppState` |
| **Ephemeral state** | `sessionStorage` | React context (PII to disk is not acceptable) |
| **Styling** | Inline `style={{}}` + CSS vars | NativeWind classes over shared tokens |
| **Push** | n/a | Doesn't exist anywhere yet (§10) |

---

## 2. Non-goals

- **No ops console.** Desktop, one operator.
- **No marketing surface** — landing page, waitlist, credit-score check, and the FX calculator stay
  web-only. Mobile is the *product*, not the funnel.
- **No Android release** this MVP — parity check only (M9).
- **No offline mode.** Money movement requires the server; a stale cached balance is worse than a
  spinner.
- **No biometric unlock** — deferred. Session lifetime matches web (1 h access / 30 d rolling refresh).
- **No in-app support chat** — `mailto:` handoff, same as web.
- **No new API capability** beyond the three additions named in M3, M7, and M8.
- **No web changes beyond import shims** — this PRD does not refactor `globals.css` or web
  components. Token-parity enforcement is a follow-up.

---

## 3. Slice M1 — Foundation

No user-visible change. Everything later sits on this.

**Promote to `packages/shared`** (auth subset only — the rest moves as consumers appear):
`translations.ts` (1,303 LOC) → `i18n/`, `apiError.ts` (64) → `api/`, `phone.ts` (8), `support.ts`
(18). Colocated tests move with them; shared already colocates (`src/types/money.test.ts`).

Web keeps its import sites via thin **named** re-export shims at `apps/web/lib/x.ts` — `export *`
would leak shared's whole type surface through `@/lib/phone`.

**Metro constraint (load-bearing):** mobile consumes the built `dist/`, not source.
`packages/shared/src/index.ts` uses NodeNext `.js` specifiers (`from './types/user.js'`) and Metro's
resolver appends extensions to the literal path rather than remapping `.js`→`.ts`. Dropping the
suffixes would break the API's build. Consequences: shared gains a `tsup --watch` `dev` script and
`turbo.json`'s `dev` task gains `dependsOn: ["^build"]`, or Metro silently runs against stale
output. Dual-format output (`esm,cjs`) because `tailwind.config.js` is CJS and must `require` the
tokens. In the `exports` map, `types` must come first or TS silently loses declarations.

No `watchFolders` work needed — `@expo/metro-config` 56 already globs `pnpm-workspace.yaml`.

**CI fix.** `.github/workflows/ci.yml:44` runs `pnpm --filter @puente/web exec next build`,
bypassing turbo. It passes today only because the earlier typecheck step incidentally builds shared.
Once web imports `@puente/shared` that accident becomes load-bearing and invisible → switch to
`pnpm turbo run build --filter=@puente/web`.

**Design tokens:** `packages/shared/src/theme/tokens.ts`, plain TS, values from `globals.css:10-55`
(sage/lime). Becomes the source of truth; a header comment names `globals.css` as the current
duplicate and defers CSS regeneration. No codegen — 16 constants don't earn a build step. Follow-up:
a web test asserting parity.

**NativeWind is a gate, not a formality.** Expo SDK 57 / RN 0.86.2 / React 19.2.3 is ahead of NativeWind
v4's tested matrix. Install, run `expo-doctor`. **If it doesn't come up clean, ship the whole PRD
with `StyleSheet.create` over the same shared tokens and amend CLAUDE.md** rather than blocking on a
styling library.

Also fix `apps/mobile/tsconfig.json` — `"@/*": ["./src/*"]` points at a directory that doesn't exist.

**Gate:** root typecheck/lint/test green · `pnpm turbo run build --filter=@puente/web` · web
`/signup` still renders Spanish by default · `expo start` boots · one `className` renders a token
color.

---

## 4. Slice M2 — Auth + shell

**The substrate** (`apps/mobile/lib/auth/`, all dependencies injected so it unit-tests in Node):

- `TokenStore` interface + a ~30-line `expo-secure-store` adapter. Keys `puente.accessToken` /
  `puente.refreshToken` / `puente.expiresAt`, all `WHEN_UNLOCKED_THIS_DEVICE_ONLY` so a session
  can't ride a device backup onto a second handset.
- `createApiClient({ baseUrl, tokens, fetchImpl?, onSignedOut? })` — Bearer injection,
  401 → refresh → retry once.
- **Single-flight refresh.** N concurrent 401s must produce exactly one refresh POST, and the
  **rotated** refresh token must be persisted — Supabase rotates on every refresh
  (`apps/api/src/routes/v1/auth.ts:196-208`), and dropping it kills the session ~1 h in as what
  looks like a random logout. A 401 *from* `/v1/auth/refresh` clears the store without recursing.
- `routeAfterSignIn()` — `apps/web/app/continue/page.tsx:19-41` ported verbatim as a pure function.

**The screens:** `(auth)/index` (phone + TCPA consent), `(auth)/verify` (OTP + 30 s resend
cooldown), `continue.tsx` (spinner → route), `(app)/_layout` guard, and five ~12-line stubs so
`typedRoutes: true` doesn't turn every routing branch into a typecheck error.

Phone travels between the two auth screens in **React context scoped to `(auth)/_layout`** — not
secure-store (persisting PII to disk for a 60-second value), not a route param (banned). Cold mount
with empty context self-heals to `/(auth)`, same as `OtpForm.tsx:19-26`.

> **A2P/TCR — load-bearing.** `packages/shared/src/i18n/translations.ts:459-472`: the campaign is registered as
> 2FA only, and the English `smsConsent` string at `:472` is quoted **verbatim** in the Twilio
> console's `message_flow` field. A prior widening was rejected with TCR error 30896. Mobile renders
> that string unmodified — no truncation, no ellipsis, no small-screen paraphrase.

**Testing: Vitest, no RNTL.** `include: ['lib/**/*.test.ts']`, exclude `app/**`. RNTL needs Jest
with the RN preset — a second runner alongside the repo's Vitest, for two forms' worth of value.
Keeping logic out of components is what makes that affordable. Revisit at M5.

**Server gap to file, not fix here:** there is no per-phone OTP limit. The only control is a global
100 req/min *per IP* (`apps/api/src/server.ts:51-61`), which does nothing against one user tapping
Resend, and each resend is a billed SMS now that Twilio is live. The client cooldown is cosmetic.
Real fix: per-phone rate limit on `/v1/auth/otp/send` keyed on a **hash** of the number (never the
number — PII rule). `OtpForm.tsx:49-63` has the identical gap.

**Gate:** sign in with `15005550006` / `123456` (`supabase/config.toml:29-30`, bypasses the provider
— no Twilio touched, no SMS billed); all five routing branches reachable; refresh and hard-sign-out
verified against the API log. **This build goes to TestFlight.**

---

## 5. Slice M3 — Profile + KYC handoff

Profile form (`ProfileForm.tsx`, 103 LOC — thin), `pending` / `rejected` screens, and the
foreground-resume poller (`PendingPoller.tsx`, 59 LOC — `visibilitychange` → `AppState`).

**The hard part is the Bridge handoff, and it needs an API change.** Web's flow is three redirects:
`POST /v1/users/me/tos-link` → Bridge ToS → `/onboarding/kyc/tos-return?signed_agreement_id=…` →
`POST /v1/users/me/kyc-link` → Persona → `/onboarding/kyc/return`. Both return pages are no-UI
server components, and `tos-return` host-allowlists the redirect to `bridge.xyz` /
`bridge.withpersona.com` (`tos-return/page.tsx:44-58`).

On mobile this becomes `expo-web-browser` `openAuthSessionAsync` with a `puente://` return URL. But
`resolveWebOrigin` (`apps/api/src/routes/v1/users.ts:75-79`) only honors origins present in
`ALLOWED_ORIGINS`, falling back to `ALLOWED_ORIGINS[0]` — a web URL. Without a change, a mobile user
finishing KYC lands in Safari on the web dashboard.

**API addition:** accept and allowlist the app's custom scheme as a redirect target. Keep the
existing host allowlist on the outbound Bridge URL unchanged — that guard protects against a
different threat and stays. Treat the scheme allowlist as security-reviewed surface.

**Blocked on:** Bridge sandbox cannot exercise hosted KYC links, so this slice is testable
end-to-end only against prod Bridge. Build it, unit-test the deep-link parsing, and flag the E2E as
deferred rather than claiming coverage it doesn't have.

**Gate:** `security-reviewer` on the scheme allowlist · `compliance-reviewer` on the GLBA
data-notice copy (`KycStart.tsx` renders `s.dataNotice` before the hand-off — it must survive the
port).

---

## 6. Slice M4 — Recipients + destinations

Port `RecipientsManager.tsx` (381 LOC, four components): add recipient, add CLABE with the
**double-entry confirm** (`:124-128`), archive with two-tap confirm, list.

**This slice establishes the client data layer**, which is why it comes before the send flow. Web
refreshes after every mutation with `router.refresh()` (`:264, :280`) — Next re-runs the server
component and re-passes `initialRecipients`. RN has no such mechanism, and the repo has no query
library and no `hooks/` directory.

**Decision: TanStack Query.** It gives cache invalidation, request dedup, and pull-to-refresh for
free, all of which get re-invented by hand otherwise — and M7's polling tracker needs
`refetchInterval` regardless. The cost is a real dependency and a caching model to learn. The
alternative (hand-rolled hooks) is less to learn and more to maintain, and it would be a third
bespoke data layer in this codebase.

`errorKeyFor` (`RecipientsManager.tsx:26-34`) is pure but stranded in the `.tsx` — extract it to
shared on the way past.

**Gate:** add/archive/list against the local stack; a mutation reflects without an app restart.

---

## 7. Slice M5 — Quote + review + disclosure

`QuoteScreen.tsx` (313 LOC, ~150 of it logic) and `ReviewConfirm.tsx` (163 LOC).

Promote to shared on the way: `sendFormat.ts` (75) and `disclosure.ts` (57).
**`sendFormat.ts:23,29,50` use `toLocaleString`/`toLocaleDateString` with options — verify Hermes
`Intl` support before relying on it**; if it's absent or partial, the fallback is explicit
formatting, not a polyfill.

`idempotency.ts` (54) also moves, but needs splitting: `createIdempotencyKeyHolder` (`:28-44`) is
React-free while `useIdempotencyKey` is a hook, and the default mint uses `crypto.randomUUID()`
(`:29`) which Hermes lacks — the mint is injectable, so mobile passes `expo-crypto`. This is where
the "where do shared hooks live" question gets answered.

Quote countdown (`mmss`, `secondsUntil`) and request-superseding on amount change
(`QuoteScreen.tsx:64,112,125`) both port directly.

Reg E prepayment disclosure comes from the API as `{content: {en, es}}` and renders verbatim —
mobile gets the bilingual copy for free, no new strings.

**Gate:** `compliance-reviewer` on the disclosure screen · quote expiry and re-quote behave as web.

---

## 8. Slice M6 — Pay

The one slice that is an integration, not a port. `lib/payStep.ts` (71 LOC — `payAffordanceFor`,
`isFundingSessionShape`, `classifyConfirmPaymentError`) moves to shared and survives intact; it's
structurally typed against Stripe's error shape (`:65-69`). The ~100 lines of Stripe.js mounting in
`PayStep.tsx:59-99, 202-294` are rewritten against `@stripe/stripe-react-native`.

Web does ACH `us_bank_account` with instant-only verification (`PayStep.tsx:274-275`), which on RN
means **Stripe Financial Connections** — a distinct integration path with its own native
configuration, not a prop change.

**Blocked on:** Stripe sandbox keys (the three-key Doppler trio; boot refuses a partial set,
`apps/api/src/config/env.ts:238-254`). Until then the dev simulate-funding affordance
(`ENABLE_DEV_ENDPOINTS`) stands in, exactly as it does on web today.

**Gate:** `security-reviewer` (financial logic) · a funded transfer from the app against the local
stack.

---

## 9. Slice M7 — Tracker + history + receipt + cancel

`TransferTracker.tsx` (437 LOC), `TransferHistory.tsx` (220, cursor-paginated), `ReceiptView.tsx`
(51), `TransferLoadError.tsx` (34).

`transferState.ts` (262 LOC + 348 LOC of tests) — the crown jewel — moves to shared here. Timeline
steps, settled-set, outcome map, badge tones, `canRequestCancel`, `classifyCancelResponse`,
`showCancellationBanner`. Zero rewrite; it's already framework-free.

Tracker polls every 5 s (`TransferTracker.tsx:27`) and pauses when backgrounded
(`visibilitychange` → `AppState`). **Flag:** mobile clients share IPs behind carrier-grade NAT
against a 100 req/min per-IP limit — worth confirming the poll interval is safe at scale, or moving
to `refetchInterval` with backoff.

**Mobile-only additions:** `mailto:` support handoff (`TransferTracker.tsx:219`) needs `Linking`,
and the receipt has no share/export affordance on mobile where web relies on the browser — add
share-sheet export. The cancel path's 202 response already carries its own bilingual copy
(`apiError.ts:47-51`), so no API change there.

**Gate:** a transfer tracked from FUNDED to COMPLETED with the app backgrounded mid-flight · cancel
within the 30-min window · receipt renders and exports.

---

## 10. Slice M8 — Push notifications

**Net-new on both sides.** `docs/api-contract.md:45-46` promises "a push notification fires on
terminal states (`COMPLETED`, `PAYOUT_FAILED`, `REFUNDED`)" and **nothing implements it** — no
table, no service, no token storage anywhere in `apps/api`, `packages/shared`, or
`supabase/migrations`.

- **Migration:** a device-token table (user, token, platform, created/last-seen), RLS deny-all,
  following the `financial-schema-checklist` skill. Tokens are device identifiers — treat as PII.
- **API:** register/deregister endpoints; a send service invoked from the worker's terminal-state
  transitions in `payment-event-process.ts`.
- **Client:** `expo-notifications`, permission prompt at the right moment (after first successful
  send, not at launch), deep link into the transfer.
- **Content rule:** never put an amount, a recipient name, or any PII in a notification body — it
  renders on a locked screen.

This is the slice most likely to be deferred past MVP. It is *not* required for the definition of
done, and it's listed last-but-one for that reason.

---

## 11. Slice M9 — Store readiness

`eas.json`, icons, splash, App Store Connect metadata, screenshots, **privacy nutrition labels**
(the app collects phone, name, email, and government ID via Bridge — the label must reflect the
Bridge hand-off, not just what Puente stores), and an Android parity pass.

**Human track, start now, blocks nothing here:** Apple Developer Program enrollment as an
**Organization** — $99/yr (same as Individual), requires a free D-U-N-S number from D&B with several
business days of lead time. An Individual account publishes under Joshua's personal legal name as
seller, which is wrong for a financial brand, and Apple expects financial-services apps to come from
the entity providing the service. Verify current requirements directly — Apple revises them.

---

## 12. Sequencing & sizing

| # | Slice | Size | Depends on | Blocked by (external) |
|---|---|---|---|---|
| M1 | Foundation | M | — | NativeWind × SDK 57 compatibility |
| M2 | Auth + shell | M | M1 | — (Twilio approved 8/10) |
| M3 | Profile + KYC | M | M2 | prod Bridge for E2E; needs an API change |
| M4 | Recipients | M | M2 | — |
| M5 | Quote + disclosure | M | M4 | — |
| M6 | Pay | L | M5 | **Stripe sandbox keys** |
| M7 | Tracker + receipt | L | M5 | — |
| M8 | Push | M | M7 | — (net-new server work) |
| M9 | Store readiness | S | M2 | **D-U-N-S → Apple org enrollment** |

M3 and M4 are independent — either can follow M2. M7 doesn't need M6 (the dev simulate affordance
reaches FUNDED without Stripe), so the tracker can be built while Stripe is still blocked.

**Parity is a moving target.** Every web slice shipped during this build widens the gap. Either
freeze web feature work during M4–M7, or accept that "caught up" means caught up to a named commit.
Worth deciding before M4.

---

## 13. Acceptance criteria (MVP-level)

- [ ] A KYC-approved user, in a TestFlight build: signs in by SMS → adds a recipient + CLABE →
      firm quote → Reg E prepayment disclosure → funds via Stripe ACH → tracks to COMPLETED →
      views and exports the receipt. No step requires the web app.
- [ ] Session survives a cold launch, a 1 h access-token expiry, and concurrent requests at the
      moment of expiry — with exactly one refresh call.
- [ ] Every user-facing string renders in EN and ES; the SMS consent paragraph matches
      `translations.ts:472` character-for-character.
- [ ] No PII in logs, URLs, or notification bodies. Tokens only in `expo-secure-store`.
- [ ] No client ever talks to Stripe or Bridge directly except through an SDK the API provisioned
      a session for.
- [ ] Every slice: tests alongside, typecheck green, `security-reviewer` on auth/financial paths,
      `compliance-reviewer` on consent-adjacent screens.
- [ ] `packages/shared` has exactly one definition of `TransferState`, error codes, and
      translations — no mirrors left in `apps/web/lib/`.

---

## 14. Reference

- Web surface being ported: `apps/web/components/{onboarding,send,recipients}/`,
  `apps/web/app/{continue,onboarding,dashboard}/`
- Portability assessment: ~1,900 LOC reuses as-is, ~700 adapts, ~2,300 rewrites (all markup, the
  server-component data layer, Stripe RN, KYC deep linking)
- API contract: `docs/api-contract.md` — note the stale auth section (`:77-78` documents
  `/v1/auth/otp/request` with `{phone, code}`; the real route is `/v1/auth/otp/send` with
  `{phone, smsConsent}` and verify takes `token`). Fix in M2.
- Prior PRDs this follows: `docs/prds/remittance-mvp.md`, `user-onboarding.md`,
  `account-lifecycle.md`

### Out of scope, noted so it isn't lost

- **`FLOAT_CEILING_MINOR` boot assert** — worker-only; belongs in `apps/api/src/worker.ts:55-67`
  beside `DATABASE_URL`, *not* in `env.ts` (shared with the API, which would then refuse to boot).
  Without it the worker boots green and every payout submit throws (`services/payouts.ts:194`).
- **No prod worker service.** `railway.worker.toml` exists; the Railway service does not. Until it
  does, a prod transfer stops dead at `FUNDED` — sender debited, nothing sent.
- **Bridge prod webhook categories.** The only documented registration
  (`docs/prds/user-onboarding.md:389`) registers `customer` only and names `BRIDGE_WEBHOOK_SECRET`
  where the code reads `BRIDGE_WEBHOOK_PUBLIC_KEY`. `customer.*` has no poll backstop anywhere.
- **Per-phone OTP rate limit** — see M2.
