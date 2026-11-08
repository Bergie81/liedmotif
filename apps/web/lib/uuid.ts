// A client-side UUID v4 for idempotency keys and controller ids. Prefers the secure
// `crypto.randomUUID`; the non-crypto fallback exists only for legacy/insecure
// contexts and is never used for anything security-sensitive.
export function makeUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  const hex = (n: number) =>
    Math.floor(Math.random() * 16 ** n)
      .toString(16)
      .padStart(n, '0');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
}
