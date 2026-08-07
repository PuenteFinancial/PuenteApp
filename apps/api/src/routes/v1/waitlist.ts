import { createHash } from 'node:crypto'
import * as Sentry from '@sentry/node'
import type { FastifyInstance } from 'fastify'
import { supabaseAdmin } from '../../services/supabase.js'
import { sendError, errorResponseSchema } from '../../utils/errors.js'

// Visible-ASCII uuid shape. Validated at the schema layer on purpose: the
// column is `uuid`, so a malformed value would fail the INSERT and surface as
// a 500 — i.e. a junk field would look exactly like the outage we are trying
// to diagnose.
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

interface WaitlistBody {
  first_name: string
  phone: string
  destination_country: string
  referral_source: string
  referral_source_other?: string
  language_preference?: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  user_agent?: string
  // Duplicate-submission diagnostics (see the 20260805134915 migration).
  submission_id?: string
  attempt?: number
  prior_error?: string
  client_distinct_id?: string
}

interface PriorRow {
  created_at: string
  submission_id: string | null
  attempt: number | null
  client_distinct_id: string | null
  user_agent: string | null
}

// Why a second row exists for a phone we already have. Each value is a
// different bug with a different fix, which is the whole point of recording it.
type Classification =
  | 'retry_after_apparent_failure' // told it failed, submitted again — WE LOSE SIGNUPS
  | 'double_fire_same_attempt' // one click produced two POSTs — UI race
  | 'repeat_signup_same_browser' // came back later and filled the form again
  | 'repeat_signup_other_browser' // same phone, different device/session
  | 'non_browser_caller' // no form session at all — script or bot
  | 'unclassifiable_legacy_row' // predecessor predates this instrumentation

// Must match the phone_normalized generated column exactly, or the lookup
// silently finds nothing and every duplicate reads as a first-time signup.
function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, '')
}

// Correlates two rows without putting a phone number in a log line or a Sentry
// event. Truncated because it only ever needs to be compared, never reversed.
function phoneKey(normalizedPhone: string): string {
  return createHash('sha256').update(normalizedPhone).digest('hex').slice(0, 12)
}

function classify(prior: PriorRow, body: WaitlistBody): Classification {
  // Same form session is the strongest signal available — it means this is the
  // SAME person finishing the SAME form, not a second visit.
  if (body.submission_id && prior.submission_id === body.submission_id) {
    return (body.attempt ?? 1) > (prior.attempt ?? 1)
      ? 'retry_after_apparent_failure'
      : 'double_fire_same_attempt'
  }
  // Checked before the legacy case: this is a fact about the CURRENT caller,
  // knowable no matter what the predecessor row looks like.
  if (!body.submission_id && !body.client_distinct_id) return 'non_browser_caller'
  if (!prior.submission_id && !prior.client_distinct_id) return 'unclassifiable_legacy_row'
  if (body.client_distinct_id && prior.client_distinct_id === body.client_distinct_id) {
    return 'repeat_signup_same_browser'
  }
  return 'repeat_signup_other_browser'
}

export async function waitlistRoute(server: FastifyInstance) {
  server.post<{ Body: WaitlistBody }>(
    '/waitlist',
    {
      config: { public: true },
      schema: {
        body: {
          type: 'object',
          required: ['first_name', 'phone', 'destination_country', 'referral_source'],
          properties: {
            first_name: { type: 'string', minLength: 1 },
            phone: { type: 'string', minLength: 1 },
            destination_country: { type: 'string', minLength: 1 },
            referral_source: { type: 'string', minLength: 1 },
            referral_source_other: { type: 'string' },
            language_preference: { type: 'string' },
            utm_source: { type: 'string' },
            utm_medium: { type: 'string' },
            utm_campaign: { type: 'string' },
            user_agent: { type: 'string' },
            submission_id: { type: 'string', pattern: UUID_PATTERN },
            attempt: { type: 'integer', minimum: 1, maximum: 50 },
            prior_error: { type: 'string', maxLength: 64 },
            client_distinct_id: { type: 'string', maxLength: 128 },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: { success: { type: 'boolean' } },
          },
          400: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const {
        first_name,
        phone,
        destination_country,
        referral_source,
        referral_source_other,
        language_preference,
        utm_source,
        utm_medium,
        utm_campaign,
        user_agent,
        submission_id,
        attempt,
        prior_error,
        client_distinct_id,
      } = request.body

      if (referral_source === 'Other' && !referral_source_other?.trim()) {
        return sendError(reply, 400, 'validation_error', 'referral_source_other is required when referral_source is "Other"')
      }

      const normalizedPhone = normalizePhone(phone)

      // Look BEFORE inserting so the predecessor is unambiguous. A failure here
      // must never cost us the signup — diagnostics are strictly secondary to
      // getting the row in.
      let priorRows: PriorRow[] = []
      const { data: priorData, error: priorLookupError } = await supabaseAdmin
        .from('waitlist')
        .select('created_at, submission_id, attempt, client_distinct_id, user_agent')
        .eq('phone_normalized', normalizedPhone)
        .order('created_at', { ascending: false })
        .limit(5)

      if (priorLookupError) {
        server.log.error(
          { supabaseError: priorLookupError.message },
          'waitlist duplicate lookup failed',
        )
      } else if (priorData) {
        priorRows = priorData as PriorRow[]
      }

      const { error } = await supabaseAdmin.from('waitlist').insert({
        first_name: first_name.trim(),
        phone: phone.trim(),
        destination_country: destination_country.trim(),
        referral_source,
        referral_source_other: referral_source === 'Other' ? referral_source_other?.trim() || null : null,
        language_preference: language_preference || 'en',
        utm_source: utm_source || null,
        utm_medium: utm_medium || null,
        utm_campaign: utm_campaign || null,
        user_agent: user_agent || null,
        submission_id: submission_id || null,
        attempt: attempt ?? null,
        prior_error: prior_error || null,
        client_distinct_id: client_distinct_id || null,
      })

      if (error) {
        server.log.error({ supabaseError: error.message }, 'waitlist insert failed')
        return sendError(reply, 500, 'internal_error', 'Failed to join waitlist')
      }

      // Reported only after the row lands, so an alert always corresponds to a
      // duplicate that actually exists.
      const prior = priorRows[0]
      if (prior) {
        const classification = classify(prior, request.body)
        const gapSeconds = Math.round((Date.now() - new Date(prior.created_at).getTime()) / 1000)
        const diagnostics = {
          classification,
          phoneKey: phoneKey(normalizedPhone),
          gapSeconds,
          priorRowCount: priorRows.length,
          attempt: attempt ?? null,
          priorAttempt: prior.attempt,
          // The proof for the retry case: what the client was shown before it
          // sent this one.
          priorError: prior_error ?? null,
          sameSubmissionId: Boolean(submission_id) && prior.submission_id === submission_id,
          sameUserAgent: prior.user_agent === (user_agent ?? null),
          requestId: request.id,
        }

        server.log.warn({ waitlistDuplicate: diagnostics }, 'duplicate waitlist submission')

        Sentry.withScope((scope) => {
          // One issue per mechanism, so the issue title IS the answer and each
          // cause can be resolved (or ignored) on its own.
          scope.setFingerprint(['waitlist-duplicate', classification])
          scope.setContext('waitlist_duplicate', diagnostics)
          Sentry.captureMessage(`waitlist duplicate submission: ${classification}`, 'warning')
        })
      }

      return { success: true }
    },
  )
}
