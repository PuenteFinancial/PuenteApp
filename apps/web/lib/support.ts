// The support address shown wherever the app tells a sender to contact us about
// a transfer. It MUST match the `contact` line in the server-authored Reg E
// disclosure (apps/api/src/services/disclosures.ts) — that is the legally
// operative address a sender is told to use to exercise their cancellation and
// error-resolution rights, and a second address on the same journey is a
// compliance problem, not a cosmetic one.
//
// NOTE: components/onboarding/RejectedCard.tsx uses a different address for KYC
// rejections. That path is not Reg E and may be intentional (a founder handling
// rejections personally) — left alone deliberately rather than unified blind.
//
// ⚠️ PRE-LAUNCH BLOCKER (confirmed with Joshua 2026-07-24): this mailbox is not
// provisioned yet. It MUST be live and monitored before the send flow is
// enabled for any real sender — this is the address on the Reg E disclosure and
// on the tracker's cancellation/error surfaces, so an unrouted inbox means a
// sender following our instructions to exercise a statutory right reaches
// nobody. Fine for the mock-only pilot; not fine for real users.
export const SUPPORT_EMAIL = 'support@puentefinancial.com'
