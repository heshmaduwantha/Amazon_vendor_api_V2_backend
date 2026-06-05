export const DEFAULT_SALES_SCHEDULER_DAY = 3; // Wednesday
export const DEFAULT_SALES_SCHEDULER_TIME = '22:00';
export const DEFAULT_SALES_SCHEDULER_TIMEZONE = 'America/New_York';
export const DEFAULT_INVENTORY_SCHEDULER_DAY = 0; // Sunday
export const DEFAULT_INVENTORY_SCHEDULER_TIME = '22:00';
export const DEFAULT_INVENTORY_SCHEDULER_TIMEZONE = 'America/New_York';

export const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export interface SchedulerConfigLike {
  dayOfWeek: number;
  timeOfDay: string;
  timezone: string;
  enabled?: boolean;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error('Timezone must be a valid IANA timezone, for example America/New_York.');
  }
}

export function normalizeSchedulerDay(dayOfWeek: number): number {
  const day = Number(dayOfWeek);
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    throw new Error('Schedule day is required and must be between Sunday and Saturday.');
  }
  return day;
}

export function parseTimeOfDay(timeOfDay: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeOfDay || '');
  if (!match) throw new Error('Schedule time is required and must use HH:mm format.');
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function normalizeSchedulerConfig<T extends SchedulerConfigLike>(config: T): T {
  const timezone = (config.timezone || '').trim();
  assertValidTimezone(timezone);
  parseTimeOfDay(config.timeOfDay);

  return {
    ...config,
    dayOfWeek: normalizeSchedulerDay(config.dayOfWeek),
    timeOfDay: config.timeOfDay,
    timezone,
  };
}

function getZonedParts(instant: Date, timezone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: map.hour === '24' ? 0 : Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function timezoneOffsetMs(instant: Date, timezone: string): number {
  const parts = getZonedParts(instant, timezone);
  const wallAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return wallAsUtc - instant.getTime();
}

function zonedWallTimeToUtc(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const firstOffset = timezoneOffsetMs(new Date(wallAsUtc), timezone);
  let utc = wallAsUtc - firstOffset;
  const refinedOffset = timezoneOffsetMs(new Date(utc), timezone);
  if (refinedOffset !== firstOffset) utc = wallAsUtc - refinedOffset;
  return new Date(utc);
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function nextScheduledRunUtc(config: SchedulerConfigLike, from: Date = new Date()): Date | null {
  if (config.enabled === false) return null;
  const normalized = normalizeSchedulerConfig(config);
  const { hour, minute } = parseTimeOfDay(normalized.timeOfDay);
  const nowParts = getZonedParts(from, normalized.timezone);
  const localToday = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day));

  for (let offset = 0; offset <= 7; offset++) {
    const localCandidateDate = addUtcDays(localToday, offset);
    if (localCandidateDate.getUTCDay() !== normalized.dayOfWeek) continue;

    const candidate = zonedWallTimeToUtc(
      normalized.timezone,
      localCandidateDate.getUTCFullYear(),
      localCandidateDate.getUTCMonth() + 1,
      localCandidateDate.getUTCDate(),
      hour,
      minute,
      0,
    );

    if (candidate.getTime() > from.getTime()) return candidate;
  }

  return null;
}

export function schedulerDisplayLabel(config: SchedulerConfigLike): string {
  const normalized = normalizeSchedulerConfig(config);
  return `${WEEKDAY_LABELS[normalized.dayOfWeek]} ${normalized.timeOfDay} ${normalized.timezone}`;
}
