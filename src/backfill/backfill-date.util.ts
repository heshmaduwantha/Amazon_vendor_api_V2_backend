export interface BackfillChunk {
  startDate: string;
  endDate: string;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function parseIsoDate(value: string, label = 'date'): Date {
  if (!ISO_DATE_PATTERN.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD format: ${value}`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || toIsoDate(date) !== value) {
    throw new Error(`${label} is not a valid calendar date: ${value}`);
  }
  return date;
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addUtcDays(value: string, days: number): string {
  const date = parseIsoDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

export function defaultBackfillStart(today = new Date()): string {
  const year = today.getUTCFullYear() - 2;
  const month = today.getUTCMonth();
  const day = today.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return toIsoDate(new Date(Date.UTC(year, month, Math.min(day, lastDay))));
}

export function generateBackwardChunks(
  startDate: string,
  endDate: string,
  chunkDays: number,
): BackfillChunk[] {
  parseIsoDate(startDate, 'start_date');
  parseIsoDate(endDate, 'end_date');
  if (!Number.isInteger(chunkDays) || chunkDays < 1) {
    throw new Error('chunk_days must be a positive integer.');
  }
  if (startDate > endDate) {
    throw new Error('start_date must be earlier than or equal to end_date.');
  }

  const chunks: BackfillChunk[] = [];
  let chunkEnd = endDate;
  while (chunkEnd >= startDate) {
    const candidateStart = addUtcDays(chunkEnd, -(chunkDays - 1));
    const chunkStart = candidateStart < startDate ? startDate : candidateStart;
    chunks.push({ startDate: chunkStart, endDate: chunkEnd });
    chunkEnd = addUtcDays(chunkStart, -1);
  }

  assertCompleteCoverage(chunks, startDate, endDate);
  return chunks;
}

export function enumerateDates(startDate: string, endDate: string): string[] {
  parseIsoDate(startDate, 'start_date');
  parseIsoDate(endDate, 'end_date');
  const dates: string[] = [];
  for (
    let current = startDate;
    current <= endDate;
    current = addUtcDays(current, 1)
  ) {
    dates.push(current);
  }
  return dates;
}

export function assertCompleteCoverage(
  chunks: BackfillChunk[],
  startDate: string,
  endDate: string,
): void {
  const covered = chunks
    .flatMap((chunk) => enumerateDates(chunk.startDate, chunk.endDate))
    .sort();
  const expected = enumerateDates(startDate, endDate);

  if (
    covered.length !== expected.length ||
    covered.some((date, index) => date !== expected[index])
  ) {
    throw new Error('Generated chunks contain a date gap or overlap.');
  }
}

export function chunkKey(chunk: BackfillChunk): string {
  return `${chunk.startDate}:${chunk.endDate}`;
}
