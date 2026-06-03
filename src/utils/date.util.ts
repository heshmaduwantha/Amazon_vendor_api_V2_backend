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
 * Last COMPLETED Sun→Sat week, with a data-finalization lag buffer.
 *
 * Amazon Vendor Central defines weeks as Sunday → Saturday.
 * Example: Week 1 of 2026 = Dec 28, 2025 (Sun) → Jan 3, 2026 (Sat)
 *
 * Amazon vendor data is typically finalized 1–3 days after the event date.
 * Using a lagDays buffer ensures we only request data that Amazon has had
 * time to finalize — so our numbers match the Vendor Central portal.
 *
 * Algorithm:
 *   1. cutoff    = today − lagDays
 *   2. weekEnd   = last Saturday on or before cutoff  (6 = Saturday)
 *   3. weekStart = Sunday of same week = Saturday − 6 days
 *
 * Example (today = Wed 2026-06-04, lagDays = 3):
 *   cutoff     = Sun 2026-06-01
 *   weekEnd    = Sat 2026-05-30  (walk back from Sun to last Saturday)
 *   weekStart  = Sun 2026-05-24
 *   → returns 2026-05-24T00:00:00Z → 2026-05-30T23:59:59Z  ✅
 */
export function getLastCompletedWeek(lagDays = 3): { startDate: string; endDate: string } {
  const now = new Date();

  // Step 1: cutoff date = today minus lag
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - lagDays),
  );

  // Step 2: walk back to last Saturday (6 = Saturday in getUTCDay)
  const dowCutoff = cutoff.getUTCDay(); // 0=Sun, 1=Mon, ... 6=Sat
  const daysToSat = (dowCutoff + 1) % 7; // days since last Saturday
  const weekEnd   = new Date(cutoff);
  weekEnd.setUTCDate(cutoff.getUTCDate() - daysToSat);

  // Step 3: Sunday of same week = Saturday - 6
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
