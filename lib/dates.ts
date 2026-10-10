export function startOfUtcDay(reference: Date = new Date()): Date {
  const date = new Date(reference);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

// Converts a YYYY-MM-DD string to the ISO instant of that day's 00:00 UTC.
export function parseDateOnlyToUtcIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const [, year, month, day] = match;
  const date = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );

  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }

  return date.toISOString();
}

// Converts a YYYY-MM-DD string to the ISO instant of the NEXT day's 00:00 UTC,
// suitable as an exclusive upper bound ("created before end of day").
export function parseDateOnlyToExclusiveEndIso(value: string): string | null {
  const startIso = parseDateOnlyToUtcIso(value);
  if (!startIso) return null;

  const start = new Date(startIso);
  start.setUTCDate(start.getUTCDate() + 1);
  return start.toISOString();
}
