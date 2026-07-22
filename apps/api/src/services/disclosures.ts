import { formatMoney, type Money } from '@puente/shared'

// Reg E prepayment disclosure content. The numbers are stored once; BOTH
// language renderings are stored alongside (i18n parity — en + es from day
// one). Wording is structurally complete but counsel-pending: the strings
// are swap-ready and versioned so approved copy is a data change.
//
// Two lines are load-bearing for compliance:
// - cancellation: the right must be disclosed even when it expires quickly
//   ("until submitted for payout" — transfer-state-machine.md, counsel flag)
// - wrong-account warning: §1005.33(h) safe harbor requires reasonable
//   verification; the disclosure carries the warning INSIDE the document.

export const DISCLOSURE_VERSION = 1

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
    cancellationRights: `You have the right to cancel this transfer and receive a full refund for ${cancelWindowMinutes} minutes after you pay, unless the funds have already been submitted for payout. To cancel, contact us at the address below.`,
    errorResolutionRights:
      'You have the right to dispute errors in this transfer. If you think there is an error, contact us within 180 days of the promised delivery date. You may also contact the Consumer Financial Protection Bureau (consumerfinance.gov).',
    wrongAccountWarning:
      'Make sure the recipient account number (CLABE) is correct. If you provide an incorrect account number and the transfer is deposited into the wrong account, you may lose the transfer amount.',
    contact: 'Puente Financial — support@puentefinancial.com',
  }
}

function renderEs(a: DisclosureAmounts, cancelWindowMinutes: number): RenderedDisclosure {
  const total = formatMoney(usd(a.sendMinor + a.feeMinor), 'es-MX')
  const send = formatMoney(usd(a.sendMinor), 'es-MX')
  const fee = formatMoney(usd(a.feeMinor), 'es-MX')
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
    cancellationRights: `Tiene derecho a cancelar esta transferencia y recibir un reembolso completo durante los ${cancelWindowMinutes} minutos posteriores al pago, salvo que los fondos ya hayan sido enviados para su entrega. Para cancelar, contáctenos en la dirección indicada abajo.`,
    errorResolutionRights:
      'Tiene derecho a disputar errores en esta transferencia. Si cree que hay un error, contáctenos dentro de los 180 días posteriores a la fecha de entrega prometida. También puede contactar al Consumer Financial Protection Bureau (consumerfinance.gov).',
    wrongAccountWarning:
      'Verifique que el número de cuenta del destinatario (CLABE) sea correcto. Si proporciona un número de cuenta incorrecto y la transferencia se deposita en la cuenta equivocada, podría perder el monto transferido.',
    contact: 'Puente Financial — support@puentefinancial.com',
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

// Reg E receipt for a COMPLETED transfer (slice-6 PR3). Per the slice-6 plan it
// reuses the prepayment content — same numbers, same renderEn/renderEs (en+es
// parity), so no new counsel-pending copy lands here. The amounts ARE the
// delivered amounts: they come from the transfer's immutable snapshot terms and
// Bridge fixes destination.amount in MXN, so the recipient received exactly the
// disclosed sum. Its own function so slice-7 receipt-specific wording lands here
// without touching the prepayment path — the deferred disclosure-wording counsel
// item: Reg E §1005.31(b)(2)(vi) requires a receipt be identified AS a receipt (a
// "Receipt" heading, a date-available line), which this reused copy does not yet
// do. Stored with type:'receipt'.
export function buildReceiptDisclosure(
  amounts: DisclosureAmounts,
  locale: 'en' | 'es',
  cancelWindowMinutes: number,
): { locale: 'en' | 'es'; content: Record<string, unknown> } {
  return buildPrepaymentDisclosure(amounts, locale, cancelWindowMinutes)
}
