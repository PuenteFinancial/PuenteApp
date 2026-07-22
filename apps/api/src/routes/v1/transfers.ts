import type { FastifyInstance, FastifyReply } from 'fastify'
import { env } from '../../config/env.js'
import { supabaseAdmin } from '../../services/supabase.js'
import { buildPrepaymentDisclosure } from '../../services/disclosures.js'
import { getFundingProcessor } from '../../services/funding/index.js'
import {
  cancelTransfer,
  canceledLedgerEntries,
  createTransferFromQuote,
  fxRateToWire,
  toApiTransfer,
  transitionTransfer,
  TransferRpcError,
  type TransferRow,
} from '../../services/transfers.js'
import { requireApprovedUser } from './recipients.js'
import { sendError, errorResponseSchema } from '../../utils/errors.js'

const TRANSFER_COLUMNS =
  'id, user_id, payout_destination_id, quote_id, state, send_amount_minor, send_currency, ' +
  'receive_amount_minor, receive_currency, fee_amount_minor, fee_currency, fx_rate, ' +
  'funding_source_type, funding_cleared, disclosure_accepted_at, payment_at, ' +
  'cancelable_until, idempotency_key, funding_payment_ref, provider_transfer_ref, ' +
  'refund_payment_ref, refunded_at, submit_attempted_at, completed_at, created_at'

const moneySchema = (currency: string) =>
  ({
    type: 'object',
    properties: {
      amountMinor: { type: 'integer' },
      currency: { type: 'string', enum: [currency] },
    },
  }) as const

const disclosureSummarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string' },
    locale: { type: 'string' },
    presentedAt: { type: 'string' },
  },
} as const

const transferResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    quoteId: { type: 'string' },
    payoutDestinationId: { type: 'string' },
    state: { type: 'string' },
    totalAmount: moneySchema('USD'),
    sendAmount: moneySchema('USD'),
    feeAmount: moneySchema('USD'),
    receiveAmount: moneySchema('MXN'),
    fxRate: { type: 'string' },
    fundingSourceType: { type: 'string' },
    fundingCleared: { type: 'boolean' },
    disclosureAcceptedAt: { type: ['string', 'null'] },
    paymentAt: { type: ['string', 'null'] },
    cancelableUntil: { type: ['string', 'null'] },
    providerTransferRef: { type: ['string', 'null'] },
    completedAt: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
    disclosure: disclosureSummarySchema,
    disclosures: { type: 'array', items: disclosureSummarySchema },
  },
} as const

interface CreateTransferBody {
  quoteId: string
}

interface ConfirmTransferBody {
  disclosureId: string
  accepted: true
}

interface CancelTransferBody {
  transferId: string
}

interface QuoteForTransferRow {
  id: string
  status: string
  expires_at: string
  send_amount_minor: number
  fee_amount_minor: number
  receive_amount_minor: number
  fx_rate: number
  payout_destinations: {
    status: string
    recipients: { status: string }
  }
}

interface ListQuery {
  limit: number
  cursor?: string
}

interface Cursor {
  c: string
  i: string
}

function decodeCursor(cursor: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor
    if (typeof parsed.c !== 'string' || typeof parsed.i !== 'string') return null
    if (!/^[0-9TZ:.+-]+$/.test(parsed.c) || !/^[0-9a-f-]{36}$/.test(parsed.i)) return null
    return parsed
  } catch {
    return null
  }
}

function encodeCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(JSON.stringify({ c: row.created_at, i: row.id })).toString('base64url')
}

// The mock processor must be unusable wherever its webhook secret isn't
// provisioned (production, by policy) — funding can't be initiated if the
// events that complete it can never arrive.
function fundingConfigured(): boolean {
  return getFundingProcessor().provider !== 'mock' || Boolean(env.MOCK_FUNDING_WEBHOOK_SECRET)
}

// A cancel that arrives once a payout is being submitted (claimed-but-still-
// FUNDED), already SUBMITTED, or IN_FLIGHT can't be auto-applied — but Reg E
// forbids a flat denial, so route to support/error-resolution and affirm the
// refund-if-the-payout-fails tail (PR2). Both language renderings travel in the
// response (like disclosures carry both); the client shows the sender's locale.
// HTTP 202: the cancellation request is accepted for out-of-band handling, not
// denied. NOTE (slice-7): the actual pending-cancel resolution track this points
// into is deferred work.
function submissionInProgressResponse(reply: FastifyReply, id: string, state: string) {
  return reply.status(202).send({
    id,
    state,
    code: 'cancellation_requires_support',
    messages: {
      en:
        "This transfer is being sent for payout and can't be canceled automatically. " +
        'Contact support to exercise your cancellation right — if the payout does not ' +
        'complete, you will be refunded in full.',
      es:
        'Esta transferencia se está enviando para su pago y no se puede cancelar ' +
        'automáticamente. Comunícate con soporte para ejercer tu derecho de cancelación: ' +
        'si el pago no se completa, se te reembolsará el monto total.',
    },
  })
}

export async function transfersRoute(server: FastifyInstance) {
  server.post<{ Body: CreateTransferBody }>(
    '/transfers',
    {
      config: {
        idempotency: true,
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (request) => request.user?.id ?? request.ip,
        },
      },
      schema: {
        body: {
          type: 'object',
          required: ['quoteId'],
          properties: { quoteId: { type: 'string', format: 'uuid' } },
          additionalProperties: false,
        },
        response: {
          201: transferResponseSchema,
          400: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          429: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id

      if (!(await requireApprovedUser(userId, reply))) return

      if (!fundingConfigured()) {
        return sendError(reply, 503, 'not_configured', 'Funding is not available yet')
      }

      // Owner-scoped quote load with the destination/recipient still-active
      // re-check: archiving after quoting must not produce a transfer.
      const { data: quoteData } = await supabaseAdmin
        .from('quotes')
        .select(
          'id, status, expires_at, send_amount_minor, fee_amount_minor, receive_amount_minor, ' +
            'fx_rate, payout_destinations!inner(status, recipients!inner(status))',
        )
        .eq('id', request.body.quoteId)
        .eq('user_id', userId)
        .single()

      if (!quoteData) {
        return sendError(reply, 404, 'not_found', 'Quote not found')
      }
      const quote = quoteData as unknown as QuoteForTransferRow
      if (
        quote.payout_destinations.status !== 'active' ||
        quote.payout_destinations.recipients.status !== 'active'
      ) {
        return sendError(reply, 409, 'conflict', 'Payout destination is archived')
      }

      // Read the locale the disclosure will be presented in.
      const { data: userData } = await supabaseAdmin
        .from('users')
        .select('preferred_language')
        .eq('id', userId)
        .single()
      const locale =
        (userData as { preferred_language?: string } | null)?.preferred_language === 'en'
          ? ('en' as const)
          : ('es' as const)

      const disclosure = buildPrepaymentDisclosure(
        {
          sendMinor: quote.send_amount_minor,
          feeMinor: quote.fee_amount_minor,
          receiveMinor: quote.receive_amount_minor,
          fxRate: fxRateToWire(quote.fx_rate),
        },
        locale,
        env.CANCEL_WINDOW_MINUTES,
      )

      try {
        const result = await createTransferFromQuote({
          quoteId: quote.id,
          userId,
          locale,
          disclosureContent: disclosure.content,
        })
        return reply.status(201).send({
          ...toApiTransfer(result.transfer),
          disclosure: {
            id: result.disclosure.id,
            type: result.disclosure.type,
            locale: result.disclosure.locale,
            presentedAt: result.disclosure.presented_at,
          },
        })
      } catch (err) {
        if (err instanceof TransferRpcError) {
          if (err.code === 'quote_not_found') {
            return sendError(reply, 404, 'not_found', 'Quote not found')
          }
          if (err.code === 'quote_consumed') {
            return sendError(reply, 409, 'conflict', 'Quote was already used')
          }
          if (err.code === 'quote_expired') {
            return sendError(reply, 409, 'quote_expired', 'Quote has expired')
          }
        }
        server.log.error({ userId, quoteId: quote.id }, 'transfer create failed')
        return sendError(reply, 500, 'internal_error', 'Failed to create transfer')
      }
    },
  )

  server.post<{ Params: { id: string }; Body: ConfirmTransferBody }>(
    '/transfers/:id/confirm',
    {
      config: { idempotency: true },
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['disclosureId', 'accepted'],
          properties: {
            disclosureId: { type: 'string', format: 'uuid' },
            // declining is just not confirming — false is not a valid request
            accepted: { type: 'boolean', enum: [true] },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              state: { type: 'string' },
              disclosureAcceptedAt: { type: 'string' },
              funding: {
                type: 'object',
                properties: {
                  provider: { type: 'string' },
                  method: { type: 'string' },
                  clientFields: { type: 'object', additionalProperties: { type: 'string' } },
                },
              },
            },
          },
          400: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id

      if (!(await requireApprovedUser(userId, reply))) return

      if (!fundingConfigured()) {
        return sendError(reply, 503, 'not_configured', 'Funding is not available yet')
      }

      const { data: transferData } = await supabaseAdmin
        .from('transfers')
        .select(TRANSFER_COLUMNS)
        .eq('id', request.params.id)
        .eq('user_id', userId)
        .single()

      if (!transferData) {
        return sendError(reply, 404, 'not_found', 'Transfer not found')
      }
      const transfer = transferData as unknown as TransferRow

      if (transfer.state !== 'PENDING_PAYMENT') {
        return sendError(reply, 409, 'conflict', 'Transfer can no longer be confirmed')
      }

      // The presented disclosure must be the one being accepted.
      const { data: disclosureData } = await supabaseAdmin
        .from('disclosures')
        .select('id')
        .eq('transfer_id', transfer.id)
        .eq('type', 'prepayment')
        .single()
      if (!disclosureData || (disclosureData as { id: string }).id !== request.body.disclosureId) {
        return sendError(reply, 400, 'validation_error', 'Disclosure does not match this transfer')
      }

      // The firm offer's window still applies at confirm (Joshua 2026-07-17):
      // the disclosed rate is never staler than the quote window.
      const { data: quoteData } = await supabaseAdmin
        .from('quotes')
        .select('expires_at')
        .eq('id', transfer.quote_id)
        .single()
      const expiresAt = (quoteData as { expires_at: string } | null)?.expires_at
      if (!expiresAt || new Date(expiresAt) <= new Date()) {
        return sendError(reply, 409, 'quote_expired', 'The quoted rate has expired')
      }

      if (transfer.disclosure_accepted_at && transfer.funding_payment_ref) {
        return sendError(reply, 409, 'conflict', 'Transfer is already confirmed')
      }

      // Record acceptance once; a retry after a failed initiation (accepted
      // but no funding ref) skips straight to re-initiation.
      let acceptedAt = transfer.disclosure_accepted_at
      if (!acceptedAt) {
        const { data: accepted, error } = await supabaseAdmin
          .from('transfers')
          .update({ disclosure_accepted_at: new Date().toISOString() })
          .eq('id', transfer.id)
          .is('disclosure_accepted_at', null)
          .select('disclosure_accepted_at')
          .single()
        if (error || !accepted) {
          // lost a race with a twin request that just accepted — re-read
          const { data: reread } = await supabaseAdmin
            .from('transfers')
            .select('disclosure_accepted_at, funding_payment_ref')
            .eq('id', transfer.id)
            .single()
          const row = reread as {
            disclosure_accepted_at: string | null
            funding_payment_ref: string | null
          } | null
          if (row?.funding_payment_ref) {
            return sendError(reply, 409, 'conflict', 'Transfer is already confirmed')
          }
          acceptedAt = row?.disclosure_accepted_at ?? null
          if (!acceptedAt) {
            server.log.error({ userId, transferId: transfer.id }, 'disclosure acceptance failed')
            return sendError(reply, 500, 'internal_error', 'Failed to confirm transfer')
          }
        } else {
          acceptedAt = (accepted as { disclosure_accepted_at: string }).disclosure_accepted_at
        }
      }

      const funding = await getFundingProcessor().initiateFunding({
        transferId: transfer.id,
        userId,
        totalAmountMinor: transfer.send_amount_minor + transfer.fee_amount_minor,
        currency: 'USD',
      })

      const { error: refError } = await supabaseAdmin
        .from('transfers')
        .update({ funding_payment_ref: funding.paymentRef })
        .eq('id', transfer.id)
        .is('funding_payment_ref', null)
      if (refError) {
        server.log.error(
          { userId, transferId: transfer.id, supabaseError: refError.code },
          'funding ref persist failed',
        )
        return sendError(reply, 500, 'internal_error', 'Failed to confirm transfer')
      }

      return {
        id: transfer.id,
        state: transfer.state,
        disclosureAcceptedAt: acceptedAt,
        funding: {
          provider: funding.provider,
          method: funding.method,
          clientFields: funding.clientFields,
        },
      }
    },
  )

  // POST /transfers/:id/cancel — the sender's Reg E cancellation right. Modeled
  // on /confirm: idempotent, owner-scoped, synchronous (the void is instant).
  // Deliberately NOT gated on requireApprovedUser or fundingConfigured: canceling
  // is a legal right that must not be blocked by KYC status, and a FUNDED
  // transfer already implies funding was configured; owner-scoping is the
  // authorization. The audit-log entry is automatic (global audit plugin).
  server.post<{ Params: { id: string }; Body: CancelTransferBody }>(
    '/transfers/:id/cancel',
    {
      config: { idempotency: true },
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        // The transfer id is REQUIRED in the body — not redundancy. The shared
        // idempotency plugin scopes a claim to (user, route-PATTERN, key) plus a
        // hash of the BODY; the concrete :id lives only in the path. With no body
        // that hash is constant across transfers, so one reused Idempotency-Key
        // would silently replay a different transfer's cancel (a money-moving
        // no-op). Carrying transferId makes the hash per-transfer (reuse across
        // transfers → an explicit 409 idempotency_conflict, never a silent
        // replay) and doubles as a path/body match check; it also gives the POST
        // a body, sidestepping Fastify's empty-application/json 400.
        body: {
          type: 'object',
          required: ['transferId'],
          properties: { transferId: { type: 'string', format: 'uuid' } },
          additionalProperties: false,
        },
        response: {
          200: transferResponseSchema,
          // being-submitted / SUBMITTED / IN_FLIGHT → compliant support routing.
          202: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              state: { type: 'string' },
              code: { type: 'string' },
              messages: {
                type: 'object',
                properties: { en: { type: 'string' }, es: { type: 'string' } },
              },
            },
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id

      if (request.body.transferId !== request.params.id) {
        return sendError(
          reply,
          400,
          'validation_error',
          'transferId must match the transfer being canceled',
        )
      }

      const { data: transferData } = await supabaseAdmin
        .from('transfers')
        .select(TRANSFER_COLUMNS)
        .eq('id', request.params.id)
        .eq('user_id', userId)
        .single()

      if (!transferData) {
        return sendError(reply, 404, 'not_found', 'Transfer not found')
      }
      let transfer = transferData as unknown as TransferRow

      // Idempotent terminal: the sender is already made whole.
      if (transfer.state === 'REFUNDED') {
        return reply.status(200).send(toApiTransfer(transfer))
      }

      // Being submitted (a claimed-but-still-FUNDED row: the submit job set
      // submit_attempted_at while state is still FUNDED, so a Bridge payout is
      // being created), already SUBMITTED, or IN_FLIGHT → compliant support
      // routing, never a flat denial. Testing submit_attempted_at here is what
      // keeps a post-claim cancel out of the FUNDED cancel path below — the state
      // column alone still reads FUNDED during the claimed-but-not-submitted
      // window, so a state-only check would wrongly deny it.
      if (
        transfer.state === 'SUBMITTED' ||
        transfer.state === 'IN_FLIGHT' ||
        (transfer.state === 'FUNDED' && transfer.submit_attempted_at !== null)
      ) {
        return submissionInProgressResponse(reply, transfer.id, transfer.state)
      }

      // FUNDED → the guarded cancel: race-safe against the payout submit claim
      // (the RPC's guarded UPDATE is the serialization point) + a clean reversal
      // of the FUNDED ledger batch. A CANCELED row (a retry after a crash between
      // the RPC and the void step) skips straight to the void step below.
      if (transfer.state === 'FUNDED') {
        try {
          transfer = await cancelTransfer({
            transferId: transfer.id,
            actor: 'user',
            reason: 'sender canceled within the Reg E window',
            ledgerDescription: 'transfer CANCELED — sender void; FUNDED batch reversed',
            ledgerEntries: canceledLedgerEntries(transfer),
          })
        } catch (err) {
          if (err instanceof TransferRpcError) {
            if (err.code === 'transfer_not_found') {
              return sendError(reply, 404, 'not_found', 'Transfer not found')
            }
            if (err.code === 'transfer_not_cancelable') {
              // The guard failed AFTER our pre-claim read. Re-read the row to
              // classify by why: a concurrent cancel (a double-click that minted
              // a fresh key, another tab) already finished → REFUNDED, so answer
              // the idempotent 200 the terminal check above would have (never a
              // misleading "window has passed" for a refunded transfer); the
              // submit job claimed/advanced it → the right is still live, 202
              // support routing; otherwise the Reg E window expired → lawful 409.
              // (An already-CANCELED row never raises — cancel_transfer returns
              // it as a replay no-op — so this handler resumes the void tail
              // rather than landing here.)
              const { data: fresh } = await supabaseAdmin
                .from('transfers')
                .select(TRANSFER_COLUMNS)
                .eq('id', transfer.id)
                .eq('user_id', userId)
                .single()
              const f = fresh as unknown as TransferRow | null
              if (f?.state === 'REFUNDED') {
                return reply.status(200).send(toApiTransfer(f))
              }
              if (
                f &&
                (f.state === 'SUBMITTED' ||
                  f.state === 'IN_FLIGHT' ||
                  (f.state === 'FUNDED' && f.submit_attempted_at !== null))
              ) {
                return submissionInProgressResponse(reply, transfer.id, f.state)
              }
              return sendError(
                reply,
                409,
                'transfer_not_cancelable',
                'The cancellation window has passed',
              )
            }
          }
          server.log.error({ userId, transferId: transfer.id }, 'transfer cancel failed')
          return sendError(reply, 500, 'internal_error', 'Failed to cancel transfer')
        }
      } else if (transfer.state !== 'CANCELED') {
        // PENDING_PAYMENT (unfunded — nothing to void; abandoned rows are reaped
        // by the reconcile-pending job), COMPLETED (funds delivered — the right
        // has extinguished; lawful denial), PAYOUT_FAILED (auto-refunds via PR2),
        // and any other state → not cancelable through this path.
        return sendError(reply, 409, 'transfer_not_cancelable', 'This transfer cannot be canceled')
      }

      // state is now CANCELED (fresh or resumed). Void the uncleared funding
      // pull, null-gated so a retry never double-calls the processor, then settle
      // REFUNDED. A FUNDED/CANCELED transfer always carries a funding_payment_ref
      // (set at confirm); its absence is a data-integrity fault — fail loudly
      // rather than void with an empty ref a real Stripe adapter could misapply.
      if (!transfer.refund_payment_ref) {
        if (!transfer.funding_payment_ref) {
          server.log.error(
            { userId, transferId: transfer.id },
            'cancel: CANCELED transfer missing funding_payment_ref',
          )
          return sendError(reply, 500, 'internal_error', 'Failed to cancel transfer')
        }
        // Keyed off the transfer's stable bridge idempotency key (not the client
        // header) so a crash-and-retry with a fresh header still dedupes the void
        // against real Stripe in slice 7.
        const undo = await getFundingProcessor().voidFunding({
          transferId: transfer.id,
          paymentRef: transfer.funding_payment_ref,
          idempotencyKey: `${transfer.idempotency_key}:void`,
        })
        const { error: persistError } = await supabaseAdmin
          .from('transfers')
          .update({ refund_payment_ref: undo.ref, refunded_at: new Date().toISOString() })
          .eq('id', transfer.id)
          .is('refund_payment_ref', null)
        if (persistError) {
          server.log.error(
            { userId, transferId: transfer.id, supabaseError: persistError.code },
            'void ref persist failed',
          )
          return sendError(reply, 500, 'internal_error', 'Failed to cancel transfer')
        }
      }

      // CANCELED → REFUNDED carries NO ledger: the FUNDED reversal already zeroed
      // the books (a receivable recognized then reversed). A concurrent finisher
      // that already reached REFUNDED replays here as a no-op returning the row.
      const refunded = await transitionTransfer({
        transferId: transfer.id,
        fromState: 'CANCELED',
        toState: 'REFUNDED',
        actor: 'user',
        reason: 'void completed — sender made whole',
      })

      return reply.status(200).send(toApiTransfer(refunded))
    },
  )

  server.get<{ Querystring: ListQuery }>(
    '/transfers',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            cursor: { type: 'string' },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: { type: 'array', items: transferResponseSchema },
              nextCursor: { type: ['string', 'null'] },
            },
          },
          400: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      const { limit } = request.query

      let cursor: Cursor | null = null
      if (request.query.cursor) {
        cursor = decodeCursor(request.query.cursor)
        if (!cursor) {
          return sendError(reply, 400, 'validation_error', 'Invalid cursor')
        }
      }

      let query = supabaseAdmin
        .from('transfers')
        .select(TRANSFER_COLUMNS)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1)

      if (cursor) {
        query = query.or(
          `created_at.lt.${cursor.c},and(created_at.eq.${cursor.c},id.lt.${cursor.i})`,
        )
      }

      const { data, error } = await query
      if (error || !data) {
        server.log.error({ userId, supabaseError: error?.code }, 'transfer list failed')
        return sendError(reply, 500, 'internal_error', 'Failed to load transfers')
      }

      const rows = data as unknown as TransferRow[]
      const page = rows.slice(0, limit)
      const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1]!) : null
      return { data: page.map(toApiTransfer), nextCursor }
    },
  )

  server.get<{ Params: { id: string } }>(
    '/transfers/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: transferResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id

      const { data, error } = await supabaseAdmin
        .from('transfers')
        .select(TRANSFER_COLUMNS)
        .eq('id', request.params.id)
        .eq('user_id', userId)
        .single()

      if (error || !data) {
        return sendError(reply, 404, 'not_found', 'Transfer not found')
      }
      const transfer = data as unknown as TransferRow

      const { data: disclosures } = await supabaseAdmin
        .from('disclosures')
        .select('id, type, locale, presented_at')
        .eq('transfer_id', transfer.id)
        .order('presented_at', { ascending: true })

      return {
        ...toApiTransfer(transfer),
        disclosures: ((disclosures ?? []) as Array<{
          id: string
          type: string
          locale: string
          presented_at: string
        }>).map((d) => ({ id: d.id, type: d.type, locale: d.locale, presentedAt: d.presented_at })),
      }
    },
  )

  // GET /transfers/:id/receipt — the Reg E receipt for a delivered transfer.
  // Owner-scoped; the receipt row exists only once the transfer reached COMPLETED
  // (written by the payment-event.process job), so its absence — pre-COMPLETED or
  // a non-owner — is a 404 (never leaks whether the transfer exists).
  server.get<{ Params: { id: string } }>(
    '/transfers/:id/receipt',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              transferId: { type: 'string' },
              type: { type: 'string' },
              locale: { type: 'string' },
              content: { type: 'object', additionalProperties: true },
              presentedAt: { type: 'string' },
            },
          },
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id

      // Owner check first — 404 (not 403) so a non-owner can't tell the transfer apart.
      const { data: owned, error: ownedError } = await supabaseAdmin
        .from('transfers')
        .select('id')
        .eq('id', request.params.id)
        .eq('user_id', userId)
        .single()
      if (ownedError || !owned) {
        return sendError(reply, 404, 'not_found', 'Receipt not found')
      }

      const { data, error } = await supabaseAdmin
        .from('disclosures')
        .select('id, transfer_id, type, locale, content, presented_at')
        .eq('transfer_id', request.params.id)
        .eq('type', 'receipt')
        .single()
      if (error || !data) {
        return sendError(reply, 404, 'not_found', 'Receipt not found')
      }
      const receipt = data as unknown as {
        id: string
        transfer_id: string
        type: string
        locale: string
        content: Record<string, unknown>
        presented_at: string
      }

      return {
        id: receipt.id,
        transferId: receipt.transfer_id,
        type: receipt.type,
        locale: receipt.locale,
        content: receipt.content,
        presentedAt: receipt.presented_at,
      }
    },
  )
}
