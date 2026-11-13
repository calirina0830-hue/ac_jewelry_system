// Reservation list date filters. A value is either a whole day ("YYYY-MM-DD")
// or an exact time ("YYYY-MM-DDTHH:mm"), both read as Philippine time (+08:00).

// Start of the filter, inclusive.
export function filterStartIso(value: string): string {
  const time = value.length > 10 ? value : value + "T00:00";
  return new Date(time + ":00+08:00").toISOString();
}

// End of the filter, exclusive. A whole day runs to the next midnight; an exact
// time includes that one minute.
export function filterEndExclusiveIso(value: string): string {
  if (value.length > 10) {
    return new Date(new Date(value + ":00+08:00").getTime() + 60_000).toISOString();
  }
  return new Date(new Date(value + "T00:00:00+08:00").getTime() + 86_400_000).toISOString();
}
