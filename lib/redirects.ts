export function getSafeRedirectPath(
  value: string | null | undefined,
  fallback = "/reservations",
): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }

  return value;
}
