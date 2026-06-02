/**
 * Normalizes a date to UTC ISO 8601 string.
 * @param date  The date to normalize
 * @param type  'start' → T00:00:00Z  |  'end' → T23:59:59Z
 */
export function normalizeDateToUTC(date: string | Date, type: 'start' | 'end'): string {
  const parsed = new Date(date);
  if (isNaN(parsed.getTime())) throw new Error('Invalid date provided to normalizeDateToUTC');

  const y = parsed.getUTCFullYear();
  const m = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const d = String(parsed.getUTCDate()).padStart(2, '0');

  return type === 'start'
    ? `${y}-${m}-${d}T00:00:00Z`
    : `${y}-${m}-${d}T23:59:59Z`;
}

/**
 * Phase 1 — Last 7 complete days (used for manual sync fallback).
 *
 * endDate   = yesterday  (last complete day)
 * startDate = 6 days before endDate  → 7-day window
 *
 * Example (today = Wed 2026-05-27):
 *   startDate = 2026-05-20T00:00:00Z
 *   endDate   = 2026-05-26T23:59:59Z
 */
export function getLastSevenDays(): { startDate: string; endDate: string } {
  const now = new Date();
  const endUtc   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const startUtc = new Date(endUtc);
  startUtc.setUTCDate(endUtc.getUTCDate() - 6);

  return {
    startDate: normalizeDateToUTC(startUtc, 'start'),
    endDate:   normalizeDateToUTC(endUtc, 'end'),
  };
}

/**
 * Phase 3 — Last COMPLETED Mon→Sun week, with a data-finalization lag buffer.
 *
 * Amazon vendor data is typically finalized 1–3 days after the event date.
 * Using a lagDays buffer ensures we only request data that Amazon has had
 * time to finalize — so our numbers match the Vendor Central portal.
 *
 * Algorithm:
 *   1. Find cutoff = today − lagDays
 *   2. Walk back to the most recent Sunday on or before cutoff  (week end)
 *   3. Monday of that same week = Sunday − 6 days              (week start)
 *
 * Example (today = Wed 2026-05-27, lagDays = 3):
 *   cutoff     = Sun 2026-05-24
 *   weekEnd    = Sun 2026-05-24  (cutoff IS a Sunday)
 *   weekStart  = Mon 2026-05-18
 *   → returns 2026-05-18T00:00:00Z → 2026-05-24T23:59:59Z  ✅
 *
 * Example (today = Mon 2026-05-25, lagDays = 3):
 *   cutoff     = Fri 2026-05-22
 *   weekEnd    = Sun 2026-05-17  (walk back from Friday to last Sunday)
 *   weekStart  = Mon 2026-05-11
 *   → returns 2026-05-11T00:00:00Z → 2026-05-17T23:59:59Z  ✅
 *   (conservative: last week is too recent to be finalized on Monday)
 */
export function getLastCompletedWeek(lagDays = 3): { startDate: string; endDate: string } {
  const now = new Date();

  // Step 1: cutoff date = today minus lag
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - lagDays),
  );

  // Step 2: walk back to last Sunday (0 = Sunday in getUTCDay)
  const dowCutoff = cutoff.getUTCDay();
  const weekEnd   = new Date(cutoff);
  if (dowCutoff !== 0) {
    weekEnd.setUTCDate(cutoff.getUTCDate() - dowCutoff);
  }

  // Step 3: Monday of same week = Sunday - 6
  const weekStart = new Date(weekEnd);
  weekStart.setUTCDate(weekEnd.getUTCDate() - 6);

  return {
    startDate: normalizeDateToUTC(weekStart, 'start'),
    endDate:   normalizeDateToUTC(weekEnd,   'end'),
  };
}

/**
 * Formats a Date as YYYY-MM-DD (UTC) — used for DB queries.
 */
export function toDateString(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
