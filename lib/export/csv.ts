export type CsvValue = string | number | null | undefined;

export function protectSpreadsheetValue(value: CsvValue): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /^[\t\r\n ]*[=+\-@]/.test(text) ? "'" + text : text;
}

export function escapeCsvCell(value: CsvValue): string {
  const protectedValue = protectSpreadsheetValue(value);
  return '"' + protectedValue.replaceAll('"', '""') + '"';
}

export function createCsv(
  headers: readonly string[],
  rows: readonly (readonly CsvValue[])[],
): string {
  const lines = [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((row) => row.map(escapeCsvCell).join(",")),
  ];

  return "\uFEFF" + lines.join("\r\n");
}
