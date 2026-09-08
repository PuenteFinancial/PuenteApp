// The one UUID shape check for web (ops board slice 1). Previously inlined in
// TransferActions; the ops transfer detail page validates its route param
// with it BEFORE any fetch, so a typo never travels upstream and an admin
// never sees "load failed" for what is really a bad id.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}
