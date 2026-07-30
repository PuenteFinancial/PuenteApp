import { formatMoney, type Money } from '@puente/shared'

// Reg E prepayment disclosure + receipt content. The numbers are stored once;
// BOTH language renderings are stored alongside (i18n parity — en + es from
// day one). Wording is swap-ready and versioned so approved copy is a data
// change.
//
// VERSION 2 (slice-7 PR7): staged for counsel sign-off + human-ES review —
// see docs/compliance/reg-e-disclosure-counsel-package.md. NEEDS LEGAL REVIEW
// (ES) applies to every Spanish string in this file. Changes from v1:
// - cancellation: extinguishing event corrected to §1005.34(a)(2) "picked up
//   or deposited" (v1's "submitted for payout" was stricter than the law).
// - error resolution: 180-day period anchored to the disclosed date of
//   availability (§1005.33(b)), not "promised delivery date".
// - receipt is now its own rendering (§1005.31(b)(2)): "Receipt" title,
//   date-available line (b)(2)(ii), recipient line (b)(2)(iii).
// - contact line adds the website ((b)(2)(v)). STILL MISSING, gated on
//   counsel/provisioning inputs (package §7, lands as v3 data change):
//   provider telephone ((b)(2)(v)) and the state-regulator/CFPB block
//   ((b)(2)(vi)).
// - wrong-account warning unchanged: §1005.33(h) safe harbor requires
//   reasonable verification; the warning lives INSIDE the document.

export const DISCLOSURE_VERSION = 2

export interface DisclosureAmounts {
  sendMinor: number
  feeMinor: number
  receiveMinor: number
  /** Fixed 4-dp decimal string, e.g. "19.9997". */
  fxRate: string
}

interface RenderedDisclosure {
  title: string
  amountLines: string[]
  fxRateLine: string
  cancellationRights: string
  errorResolutionRights: string
  wrongAccountWarning: string
  contact: string
  /** Receipt only (§1005.31(b)(2)(iii)): "Recipient: {first} {last}". */
  recipientLine?: string
  /** Receipt only (§1005.31(b)(2)(ii)): delivery date in the recipient's country. */
  dateAvailableLine?: string
}

/** The receipt-specific facts §1005.31(b)(2) adds on top of the (b)(1) content. */
export interface ReceiptFacts {
  /** ISO timestamp of delivery (the COMPLETED transition), NOT a wall-clock now(). */
  dateAvailableIso: string
  recipientFirstName: string
  recipientLastName: string
}

// (b)(2)(ii) wants "the date in the foreign country on which funds will be
// available" — the CDMX calendar day of delivery, which near a midnight UTC
// boundary is not the UTC day.
function formatDateAvailable(iso: string, locale: 'en' | 'es'): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-MX', {
    dateStyle: 'long',
    timeZone: 'America/Mexico_City',
  }).format(new Date(iso))
}

const usd = (amountMinor: number): Money => ({ amountMinor, currency: 'USD' })
const mxn = (amountMinor: number): Money => ({ amountMinor, currency: 'MXN' })

function renderEn(a: DisclosureAmounts, cancelWindowMinutes: number): RenderedDisclosure {
  const total = formatMoney(usd(a.sendMinor + a.feeMinor), 'en-US')
  const send = formatMoney(usd(a.sendMinor), 'en-US')
  const fee = formatMoney(usd(a.feeMinor), 'en-US')
  const receive = formatMoney(mxn(a.receiveMinor), 'es-MX')
  return {
    title: 'Prepayment disclosure',
    amountLines: [
      `Transfer amount: ${send}`,
      `Transfer fee: ${fee}`,
      `Total to pay: ${total}`,
      `Amount to be received: ${receive} MXN`,
    ],
    fxRateLine: `Exchange rate: 1 USD = ${a.fxRate} MXN`,
    cancellationRights: `You have the right to cancel this transfer and receive a full refund for ${cancelWindowMinutes} minutes after you pay, unless the funds have already been picked up by your recipient or deposited into your recipient's account. To cancel, contact us at the address below.`,
    errorResolutionRights:
      'You have the right to dispute errors in this transfer. If you think there is an error, contact us within 180 days of the date we promised the funds would be available to your recipient. You may also contact the Consumer Financial Protection Bureau (consumerfinance.gov).',
    wrongAccountWarning:
      'Make sure the recipient account number (CLABE) is correct. If you provide an incorrect account number and the transfer is deposited into the wrong account, you may lose the transfer amount.',
    contact: 'Puente Financial · support@puentefinancial.com · puentefinancial.com',
  }
}

function renderEs(a: DisclosureAmounts, cancelWindowMinutes: number): RenderedDisclosure {
  // USD amounts are formatted with 'en-US', NOT 'es-MX', even in the Spanish
  // rendering. Intl treats USD as a FOREIGN currency in the Mexican locale and
  // renders it with a code prefix — "USD 99.00" — so appending the " USD"
  // suffix below produced "USD 99.00 USD" in the legally-operative Reg E copy.
  // 'en-US' gives "$99.00", so the line reads "$99.00 USD", matching renderEn.
  // MXN keeps 'es-MX', where it is the local currency and correctly renders "$".
  const total = formatMoney(usd(a.sendMinor + a.feeMinor), 'en-US')
  const send = formatMoney(usd(a.sendMinor), 'en-US')
  const fee = formatMoney(usd(a.feeMinor), 'en-US')
  const receive = formatMoney(mxn(a.receiveMinor), 'es-MX')
  return {
    title: 'Divulgación previa al pago',
    amountLines: [
      `Monto de la transferencia: ${send} USD`,
      `Comisión por transferencia: ${fee} USD`,
      `Total a pagar: ${total} USD`,
      `Monto a recibir: ${receive} MXN`,
    ],
    fxRateLine: `Tipo de cambio: 1 USD = ${a.fxRate} MXN`,
    // NEEDS LEGAL REVIEW (ES) — machine-drafted; human review gated in PR7.
    cancellationRights: `Tiene derecho a cancelar esta transferencia y recibir un reembolso completo durante los ${cancelWindowMinutes} minutos posteriores al pago, salvo que los fondos ya hayan sido retirados por el destinatario o depositados en la cuenta del destinatario. Para cancelar, contáctenos en la dirección indicada abajo.`,
    errorResolutionRights:
      'Tiene derecho a disputar errores en esta transferencia. Si cree que hay un error, contáctenos dentro de los 180 días posteriores a la fecha en que prometimos que los fondos estarían disponibles para su destinatario. También puede contactar al Consumer Financial Protection Bureau (consumerfinance.gov).',
    wrongAccountWarning:
      'Verifique que el número de cuenta del destinatario (CLABE) sea correcto. Si proporciona un número de cuenta incorrecto y la transferencia se deposita en la cuenta equivocada, podría perder el monto transferido.',
    contact: 'Puente Financial · support@puentefinancial.com · puentefinancial.com',
  }
}

export function buildPrepaymentDisclosure(
  amounts: DisclosureAmounts,
  locale: 'en' | 'es',
  cancelWindowMinutes: number,
): { locale: 'en' | 'es'; content: Record<string, unknown> } {
  return {
    locale,
    content: {
      version: DISCLOSURE_VERSION,
      amounts: {
        sendMinor: amounts.sendMinor,
        feeMinor: amounts.feeMinor,
        totalMinor: amounts.sendMinor + amounts.feeMinor,
        sendCurrency: 'USD',
        receiveMinor: amounts.receiveMinor,
        receiveCurrency: 'MXN',
        fxRate: amounts.fxRate,
      },
      cancelWindowMinutes,
      en: renderEn(amounts, cancelWindowMinutes),
      es: renderEs(amounts, cancelWindowMinutes),
    },
  }
}

// Reg E receipt for a COMPLETED transfer. §1005.31(b)(2) = the (b)(1) content
// PLUS receipt-specific items; v2 adds the ones derivable from our own records:
// a "Receipt" title, the date-available line ((b)(2)(ii) — the CDMX calendar
// day of delivery) and the recipient line ((b)(2)(iii)). The amounts ARE the
// delivered amounts: immutable snapshot terms, and Bridge fixes
// destination.amount in MXN, so the recipient received exactly the disclosed
// sum. Still missing pending counsel/provisioning inputs (package §7, v3 data
// change): provider telephone ((b)(2)(v)) and the state-regulator/CFPB block
// ((b)(2)(vi)). Stored with type:'receipt'.
export function buildReceiptDisclosure(
  amounts: DisclosureAmounts,
  locale: 'en' | 'es',
  cancelWindowMinutes: number,
  facts: ReceiptFacts,
): { locale: 'en' | 'es'; content: Record<string, unknown> } {
  const base = buildPrepaymentDisclosure(amounts, locale, cancelWindowMinutes)
  const recipient = `${facts.recipientFirstName} ${facts.recipientLastName}`
  const en: RenderedDisclosure = {
    ...(base.content['en'] as RenderedDisclosure),
    title: 'Receipt',
    recipientLine: `Recipient: ${recipient}`,
    dateAvailableLine: `Date available: ${formatDateAvailable(facts.dateAvailableIso, 'en')}`,
  }
  // NEEDS LEGAL REVIEW (ES) — machine-drafted; human review gated in PR7.
  const es: RenderedDisclosure = {
    ...(base.content['es'] as RenderedDisclosure),
    title: 'Recibo',
    recipientLine: `Destinatario: ${recipient}`,
    dateAvailableLine: `Fecha de disponibilidad: ${formatDateAvailable(facts.dateAvailableIso, 'es')}`,
  }
  return { locale, content: { ...base.content, en, es } }
}
