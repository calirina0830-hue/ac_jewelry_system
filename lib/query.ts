export function sanitizeSearchTerm(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}\s@.+_\/-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toSearchPattern(value: string): string {
  const terms = value.trim().split(/\s+/).filter(Boolean);
  return "%" + terms.join("%") + "%";
}

export function normalizeSearchText(value: string | null | undefined): string {
  return (value ?? "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function toSearchParams(
  values: Record<string, string | number | undefined>,
): URLSearchParams {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }

  return params;
}
