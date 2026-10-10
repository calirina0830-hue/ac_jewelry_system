export function buildBulkPaymentHref(ids: string[]): string {
  const params = new URLSearchParams();
  [...new Set(ids)].forEach((id) => params.append("ids", id));
  return "/reservations/bulk/pay?" + params.toString();
}

export function parseBulkPaymentIds(
  value: string | string[] | undefined,
): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}
