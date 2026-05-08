/**
 * Normalizes a date to UTC ISO 8601 string.
 * @param date The date to normalize
 * @param type 'start' sets time to T00:00:00Z, 'end' sets time to T23:59:59Z
 * @returns ISO 8601 normalized string
 */
export function normalizeDateToUTC(date: string | Date, type: 'start' | 'end'): string {
  const parsedDate = new Date(date);
  
  if (isNaN(parsedDate.getTime())) {
    throw new Error('Invalid date provided to normalizeDateToUTC');
  }

  // Use UTC methods to ensure the date is built properly without local time offset issues
  const year = parsedDate.getUTCFullYear();
  const month = parsedDate.getUTCMonth();
  const day = parsedDate.getUTCDate();

  const targetDate = new Date(Date.UTC(year, month, day));

  if (type === 'start') {
    targetDate.setUTCHours(0, 0, 0, 0);
  } else if (type === 'end') {
    targetDate.setUTCHours(23, 59, 59, 999);
  }

  // The requirement was T23:59:59Z, but usually milliseconds are kept as .999Z or stripped
  // Let's format it explicitly to match T00:00:00Z and T23:59:59Z exactly to satisfy the "100% data tallying" requirement.
  
  const formattedYear = targetDate.getUTCFullYear();
  const formattedMonth = String(targetDate.getUTCMonth() + 1).padStart(2, '0');
  const formattedDay = String(targetDate.getUTCDate()).padStart(2, '0');

  if (type === 'start') {
    return `${formattedYear}-${formattedMonth}-${formattedDay}T00:00:00Z`;
  } else {
    return `${formattedYear}-${formattedMonth}-${formattedDay}T23:59:59Z`;
  }
}
