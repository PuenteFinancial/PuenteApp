import { env } from '../config/env.js'
import { supabaseAdmin } from './supabase.js'

// The merchant-scoped Stripe Customer a sender's saved payment methods hang off.
//
// Minted lazily at the first funding session and then never changed. Deliberately
// NOT created at signup: most users never send, and a Customer with no payment
// activity is a record of a person we hold for no reason.
//
// Scoped to US, our account, and nothing else. This is not Link: a method saved
// against this Customer is visible to Puente alone, which is why enabling saving
// does not reintroduce Link's phone-number step in the pay step.

interface EnsureInput {
  userId: string
  email?: string | undefined
}

/**
 * Return this user's Stripe Customer id, creating one if they have none.
 *
 * NEVER THROWS ONWARD. Saving a payment method is a convenience layered on top
 * of a payment; a Stripe outage here must not stop someone sending money. A
 * null return means "no Customer this time", and the session is created exactly
 * as it was before saving existed — the sender pays, nothing is offered to
 * save, and the next send tries again.
 *
 * The create is keyed on the user id, so a retry after a lost response returns
 * the SAME Customer rather than minting a second one. That matters more than it
 * looks: two Customers for one sender splits their saved methods invisibly, and
 * presents to them as "my bank disappeared".
 */
export async function ensureStripeCustomer(input: EnsureInput): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('stripe_customer_id')
    .eq('id', input.userId)
    .maybeSingle()
  if (error) return null
  const existing = (data as { stripe_customer_id: string | null } | null)?.stripe_customer_id
  if (existing) return existing

  let customerId: string
  try {
    const form = new URLSearchParams()
    // Email is a convenience for the Stripe dashboard and for Checkout's
    // prefill. Name is deliberately omitted: it adds nothing Stripe needs here
    // and this record already reaches further than we would like.
    if (input.email) form.set('email', input.email)
    form.set('metadata[user_id]', input.userId)

    const res = await fetch(`${env.STRIPE_API_BASE}/v1/customers`, {
      method: 'POST',
      signal: AbortSignal.timeout(env.STRIPE_TIMEOUT_SECONDS * 1000),
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        // Same key on every retry for this user, so a lost response replays.
        'Idempotency-Key': `customer_${input.userId}`,
      },
      body: form,
    })
    if (!res.ok) return null
    const body = (await res.json()) as { id?: string }
    if (!body.id) return null
    customerId = body.id
  } catch {
    return null
  }

  // Guarded on the column still being null, so a concurrent confirm that won
  // the race keeps ITS customer and this one is abandoned rather than
  // overwriting. An abandoned Customer is inert: no methods, no charges.
  const { error: saveError } = await supabaseAdmin
    .from('users')
    .update({ stripe_customer_id: customerId })
    .eq('id', input.userId)
    .is('stripe_customer_id', null)
  if (saveError) return null

  // Re-read rather than trusting our own write: if the racing caller won, the
  // persisted id is theirs and it is the one the session must use, or the
  // sender's saved methods split across two Customers.
  const { data: after } = await supabaseAdmin
    .from('users')
    .select('stripe_customer_id')
    .eq('id', input.userId)
    .maybeSingle()
  return (after as { stripe_customer_id: string | null } | null)?.stripe_customer_id ?? null
}
