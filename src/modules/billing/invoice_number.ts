/** First invoice number of a year is INV-<year>-1001. */
const FIRST_SEQUENCE = 1001;

/**
 * Next invoice number for `year`, one above the highest sequence already used that year.
 * `existing` must hold every known invoice number (database and memory). Numbers from other years or in another
 * format are ignored, so the sequence resets each January and never reuses a number after a restart.
 */
export function nextInvoiceNumber(existing: Iterable<string>, year: number): string {
  const prefix = `INV-${year}-`;
  let highest = FIRST_SEQUENCE - 1;
  for (const no of existing) {
    if (!no.startsWith(prefix)) continue;
    const tail = no.slice(prefix.length);
    if (!/^\d+$/.test(tail)) continue;
    const seq = Number(tail);
    if (Number.isSafeInteger(seq) && seq > highest) highest = seq;
  }
  return `${prefix}${highest + 1}`;
}

/** True for a unique-constraint violation from Prisma (P2002) or from Postgres directly (23505). */
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'P2002' || code === '23505';
}
