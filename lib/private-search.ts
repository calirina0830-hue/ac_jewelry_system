import { sanitizeSearchTerm } from "@/lib/query";

export const PRIVATE_SEARCH_COOKIE_NAMES = {
  customers: "private-search-customers",
  reservations: "private-search-reservations",
  shipments: "private-search-shipments",
} as const;

export type PrivateSearchScope = keyof typeof PRIVATE_SEARCH_COOKIE_NAMES;

export function readPrivateSearchTerm(
  cookieValue: string | undefined,
  userId: string | null | undefined,
): string {
  if (!cookieValue || !userId) return "";

  try {
    const value: unknown = JSON.parse(cookieValue);
    if (
      typeof value !== "object" ||
      value === null ||
      !("userId" in value) ||
      !("term" in value) ||
      value.userId !== userId ||
      typeof value.term !== "string"
    ) {
      return "";
    }

    return sanitizeSearchTerm(value.term).slice(0, 100);
  } catch {
    return "";
  }
}
