/**
 * Marketplace-timezone date helpers for Amazon Vendor reports.
 *
 * The US marketplace (ATVPDKIKX0DER) buckets Vendor Sales/Inventory data by the
 * America/Los_Angeles calendar day. `dataStartTime` / `dataEndTime` therefore must
 * be the UTC instants that correspond to Pacific midnight boundaries, otherwise the
 * day buckets shift and the totals do not tally with Vendor Central.
 *
 * DST is handled by Node's built-in IANA tz database via Intl.DateTimeFormat — we
 * never hardcode a -7 / -8 offset.
 */

const PACIFIC_TZ = 'America/Los_Angeles';

/** Calendar day, as seen on a Pacific wall clock. */
export interface PacificDay {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

/** The Pacific calendar day (Y/M/D) that the given UTC instant falls on. */
export function pacificCalendarDay(instant: Date): PacificDay {
  // en-CA renders as YYYY-MM-DD, which is trivial to parse.
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: PACIFIC_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  const [year, month, day] = formatted.split('-').map(Number);
  return { year, month, day };
}

/**
 * Offset (Pacific - UTC) in milliseconds at the given instant.
 * Negative for both PST (-8h) and PDT (-7h); the exact value comes from the tz db.
 */
function pacificOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;

  // Intl can emit hour "24" at midnight; normalise to 0.
  const hour = map.hour === '24' ? 0 : Number(map.hour);
  const wallAsUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second),
  );
  return wallAsUtc - instant.getTime();
}

/**
 * Convert a Pacific wall-clock time to the corresponding UTC instant.
 * Re-checks the offset at the resolved instant so DST transition days are correct.
 */
function pacificWallToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms = 0,
): Date {
  // Measure the offset at second-resolution (Intl has no milliseconds), then add the
  // milliseconds back at the very end so they cannot contaminate the offset arithmetic.
  const wallNoMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const firstGuessOffset = pacificOffsetMs(new Date(wallNoMs));
  let utc = wallNoMs - firstGuessOffset;
  const refinedOffset = pacificOffsetMs(new Date(utc));
  if (refinedOffset !== firstGuessOffset) {
    utc = wallNoMs - refinedOffset;
  }
  return new Date(utc + ms);
}

/** 00:00:00.000 Pacific for the Pacific calendar day containing `instant`, as a UTC Date. */
export function pacificDayStartUtc(instant: Date): Date {
  const { year, month, day } = pacificCalendarDay(instant);
  return pacificWallToUtc(year, month, day, 0, 0, 0, 0);
}

/** 23:59:59.999 Pacific for the Pacific calendar day containing `instant`, as a UTC Date. */
export function pacificDayEndUtc(instant: Date): Date {
  const { year, month, day } = pacificCalendarDay(instant);
  return pacificWallToUtc(year, month, day, 23, 59, 59, 999);
}

/** ISO 8601 (UTC) for 00:00:00 Pacific of the day containing `instant`. */
export function pacificDayStartIso(instant: Date): string {
  return pacificDayStartUtc(instant).toISOString();
}

/** ISO 8601 (UTC) for 23:59:59.999 Pacific of the day containing `instant`. */
export function pacificDayEndIso(instant: Date): string {
  return pacificDayEndUtc(instant).toISOString();
}

/** The Pacific weekday (0 = Sunday … 6 = Saturday) for `instant`. */
export function pacificWeekday(instant: Date): number {
  const { year, month, day } = pacificCalendarDay(instant);
  // getUTCDay on the Y/M/D components yields the weekday independent of any offset.
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * Align a range to Pacific week boundaries (Sunday 00:00:00 → Saturday 23:59:59.999),
 * for use when reportPeriod = WEEK.
 *
 * `start` is moved back to the Sunday of its week; `end` is moved forward to the
 * Saturday of its week.
 */
export function alignToPacificWeek(
  start: Date,
  end: Date,
): { dataStartTime: Date; dataEndTime: Date } {
  const startWeekday = pacificWeekday(start);
  const startDay = pacificCalendarDay(start);
  const sunday = pacificWallToUtc(
    startDay.year,
    startDay.month,
    startDay.day - startWeekday,
    0,
    0,
    0,
    0,
  );

  const endWeekday = pacificWeekday(end);
  const endDay = pacificCalendarDay(end);
  const saturday = pacificWallToUtc(
    endDay.year,
    endDay.month,
    endDay.day + (6 - endWeekday),
    23,
    59,
    59,
    999,
  );

  return { dataStartTime: sunday, dataEndTime: saturday };
}

/** Add (or subtract) whole Pacific calendar days, preserving the wall-clock time-of-day intent. */
export function addPacificDays(instant: Date, days: number): Date {
  const { year, month, day } = pacificCalendarDay(instant);
  return pacificWallToUtc(year, month, day + days, 0, 0, 0, 0);
}
