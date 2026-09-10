// The words themselves. A COPY TABLE, and nothing else lives here: it is listed
// in eslint.config.js beside translations.ts and the web's legal content, so the
// no-em-dashes rule for customer-facing copy applies to every string in the
// file. Splitting it out of sender-notices.ts is what keeps that rule honest —
// in a mixed module the same rule fires on log lines and Sentry messages, which
// are operator text, and the fix people reach for is an eslint-disable that
// then covers the copy too.
//
// WHY THE COPY IS SERVER-SIDE AT ALL, not in @puente/shared/i18n: this is
// server-SENT customer copy, the same shape as the Reg E disclosures and
// receipts in disclosures.ts, which render en + es inline for the same reason.
// Nothing client-side displays it, and importing the 1,300-line UI copy table
// would put it in the funding webhook's boot path, which is precisely what the
// subpath export in packages/shared/src/i18n/index.ts exists to prevent.

import { SUPPORT_EMAIL } from '@puente/shared'

export type NoticeLanguage = 'en' | 'es'
export type SenderNoticeKind = 'account_frozen'
/**
 * How the notice was dispatched. 'manual' means it was NOT sent by machine:
 * it is rendered, stored, and handed to an operator to deliver. That is the
 * only value today, and the reason is infrastructural, not a preference —
 * see the migration and docs/runbooks/proposals/funding-reversal.md.
 */
export type NoticeChannel = 'manual'
export type NoticeStatus = 'pending' | 'sent' | 'failed'

export interface RenderedNotice {
  subject: string
  body: string
}

// NEEDS LEGAL REVIEW (EN + ES). The Spanish is not a machine translation, but
// it has had no native-speaker review — same standing caveat as every ES string
// in disclosures.ts.
//
// What the copy may and may not say, all three constraints from the same
// review:
//  - Say the account is on hold and why AT A GENERAL LEVEL. "A problem with a
//    payment" matches the `send.errors.account_suspended` string the sender
//    sees in-product, so the two do not contradict each other.
//  - Disclose NO dispute specifics. Which transfer, which return code, what the
//    bank said, and when the window closes are all things that help a
//    fraudulent actor and help nobody else.
//  - Name the surviving right. Cancellation is deliberately left ungated for a
//    frozen sender (Reg E), so the notice says so rather than letting the
//    freeze read as total.
//  - PROMISE NOTHING WE CANNOT DO. An earlier draft ended "and we will get back
//    to you" (compliance review 2026-09-10, blocking). `SUPPORT_EMAIL` is a
//    documented PRE-LAUNCH BLOCKER: the mailbox is not provisioned
//    (packages/shared/src/support.ts). Telling someone whose account just
//    stopped to write in and wait for a reply is a material misrepresentation
//    they would act on, and it is worse here than on the disclosure because the
//    injury has already happened. So the notice leads with the contact we
//    ACTUALLY make (a person, by phone, because that is what 'manual' delivery
//    is) and names the address without promising an answer.
//  - ONE address, never a second. support.ts is explicit that a different
//    contact on the same journey is a compliance problem, not a cosmetic one:
//    it is the Reg E address a sender is told to use for cancellation and error
//    resolution. Hence the import rather than a literal, so the two cannot drift.
//  - No name, no amount, nothing else interpolated: the only substitution is a
//    build-time constant, so the rendered text is still fixed per (kind,
//    language) and stays PII-free by construction.
const ACCOUNT_FROZEN: Record<NoticeLanguage, RenderedNotice> = {
  en: {
    subject: 'Your Puente account is on hold',
    body: [
      'Your Puente account is on hold while we look into a problem with a payment used to fund a recent transfer. While the hold is in place you cannot start a new transfer.',
      'If you already paid for a transfer that has not been sent yet, you can still cancel it and get your money back.',
      `Someone from Puente is contacting you about this. If you think it is a mistake, or you want to clear it up, our support address is ${SUPPORT_EMAIL}.`,
    ].join('\n\n'),
  },
  es: {
    subject: 'Tu cuenta de Puente está en revisión',
    body: [
      'Tu cuenta de Puente está en revisión mientras investigamos un problema con un pago que usaste para financiar una transferencia reciente. Mientras dure la revisión no puedes iniciar una transferencia nueva.',
      'Si ya pagaste una transferencia que todavía no se ha enviado, aún puedes cancelarla y recuperar tu dinero.',
      `Alguien de Puente se está comunicando contigo por este motivo. Si crees que es un error, o quieres resolverlo, nuestra dirección de soporte es ${SUPPORT_EMAIL}.`,
    ].join('\n\n'),
  },
}

/** The stored copy for one notice. Fixed per (kind, language) — nothing interpolated. */
export function renderAccountFrozenNotice(language: NoticeLanguage): RenderedNotice {
  return ACCOUNT_FROZEN[language]
}

/**
 * users.preferred_language is CHECK-constrained to 'en' | 'es', but this reads
 * a value that may have failed to load at all (the pre-read is deliberately
 * non-fatal — a freeze must not depend on it). English is the fallback because
 * it is the column default, not because it is the likelier language here.
 */
export function noticeLanguage(preferred: string | null | undefined): NoticeLanguage {
  return preferred === 'es' ? 'es' : 'en'
}
