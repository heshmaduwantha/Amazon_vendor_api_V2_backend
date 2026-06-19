const DAY_MS = 86_400_000;

export interface AmazonWeekInfo {
  amazonYear: number;
  weekNumber: number;
  weekStartDate: string;
  weekEndDate: string;
}

export interface AmazonWeekRange extends AmazonWeekInfo {
  startDate: string;
  endDate: string;
  label: string;
}

function toUtcDateOnly(input: string | Date): Date {
  if (typeof input === 'string') {
    const datePart = input.slice(0, 10);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
    if (!match) throw new Error('Date must be a valid YYYY-MM-DD or ISO date string.');
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }

  if (isNaN(input.getTime())) throw new Error('Date must be valid.');
  return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function firstSundayOnOrBeforeJanOne(year: number): Date {
  const janOne = new Date(Date.UTC(year, 0, 1));
  return addUtcDays(janOne, -janOne.getUTCDay());
}

function sundayOnOrBefore(date: Date): Date {
  return addUtcDays(date, -date.getUTCDay());
}

export function getAmazonWeekInfo(input: string | Date): AmazonWeekInfo {
  const date = toUtcDateOnly(input);
  const calendarYear = date.getUTCFullYear();
  const nextAmazonYearStart = firstSundayOnOrBeforeJanOne(calendarYear + 1);
  const amazonYear = date >= nextAmazonYearStart ? calendarYear + 1 : calendarYear;
  const amazonYearStart = firstSundayOnOrBeforeJanOne(amazonYear);

  const weekStart = sundayOnOrBefore(date);
  const weekEnd = addUtcDays(weekStart, 6);
  const weekNumber = Math.floor((weekStart.getTime() - amazonYearStart.getTime()) / (7 * DAY_MS)) + 1;

  return {
    amazonYear,
    weekNumber,
    weekStartDate: formatDate(weekStart),
    weekEndDate: formatDate(weekEnd),
  };
}

export function toAmazonWeekRange(info: AmazonWeekInfo): AmazonWeekRange {
  const paddedWeek = String(info.weekNumber).padStart(2, '0');
  return {
    ...info,
    startDate: info.weekStartDate,
    endDate: info.weekEndDate,
    label: `${info.amazonYear} Week ${paddedWeek}`,
  };
}

export function getLastCompletedAmazonWeek(referenceDate: string | Date = new Date()): AmazonWeekRange {
  return getPreviousCompletedAmazonWeeks(1, referenceDate)[0];
}

export function getPreviousCompletedAmazonWeeks(
  count: number,
  referenceDate: string | Date = new Date(),
): AmazonWeekRange[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('count must be a positive integer.');
  }

  const currentWeekStart = sundayOnOrBefore(toUtcDateOnly(referenceDate));
  return Array.from({ length: count }, (_, index) => {
    const weekDate = addUtcDays(currentWeekStart, -7 * (index + 1));
    return toAmazonWeekRange(getAmazonWeekInfo(weekDate));
  });
}
