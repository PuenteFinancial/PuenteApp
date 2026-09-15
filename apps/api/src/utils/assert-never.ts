/**
 * Make a union exhaustive at COMPILE time, and loud at runtime if it ever isn't.
 *
 * The parameter is `never`, so TypeScript accepts the call only when every
 * variant has already been handled above it. Add a variant to the union and
 * every `switch` that ends in `assertNever` stops compiling, naming the file and
 * line that forgot it. That is the whole point: a refusal reason is added by
 * someone thinking about the service, and the routes that must translate it are
 * in other files they are not looking at.
 *
 * This existed only as a promise until now. `refunds.ts` documented a
 * `assertNever` default on its RefundOutcome union — "so a future third refusal
 * breaks the build instead of silently taking someone else's branch" — and the
 * helper was never written. #346 then added that exact third refusal
 * (`funding_disputed`); the build did not break, and the ops route's switch was
 * updated by hand instead. It happened to be correct. The next one has nothing
 * catching it, which is what this file is for.
 *
 * The runtime throw is the backstop for the case the type system cannot see: a
 * value that reached us from the database or a provider carrying a variant the
 * types did not predict. On the ops money routes that lands in the surrounding
 * catch, which logs and returns a 500 — correct, because an unrecognised refusal
 * IS a server fault, and a non-2xx releases the idempotency claim so a retry is
 * safe once the code knows the variant.
 *
 * Only the discriminant is put in the message. The unhandled value is an outcome
 * object, and outcome objects carry transfer ids and provider detail strings —
 * nothing that belongs in an error message that may be logged verbatim.
 */
export function assertNever(value: never, context: string): never {
  const tag =
    typeof value === 'object' && value !== null && 'reason' in value
      ? String((value as { reason: unknown }).reason)
      : typeof value === 'object' && value !== null && 'outcome' in value
        ? String((value as { outcome: unknown }).outcome)
        : String(value)
  throw new Error(`${context}: unhandled variant '${tag}'`)
}
