const currencyFormatter = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
});

const dateFormatter = new Intl.DateTimeFormat("en-PH", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-PH", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

// Business operates in the Philippines, so per-item order dates are always
// rendered in Asia/Manila regardless of where the server runs.
export const MANILA_TIME_ZONE = "Asia/Manila";

const manilaDateTimeFormatter = new Intl.DateTimeFormat("en-PH", {
  timeZone: MANILA_TIME_ZONE,
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const manilaDateFormatter = new Intl.DateTimeFormat("en-PH", {
  timeZone: MANILA_TIME_ZONE,
  year: "numeric",
  month: "short",
  day: "numeric",
});

export function formatCurrency(value: number): string {
  return currencyFormatter.format(value);
}

export function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

export function formatDateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}

export function formatManilaDateTime(value: string): string {
  return manilaDateTimeFormatter.format(new Date(value));
}

export function formatManilaDate(value: string): string {
  return manilaDateFormatter.format(new Date(value));
}

// Missing order dates are shown as-is (never invented) for legacy rows.
export const ORDER_DATE_FALLBACK = "Date not recorded";

export function formatOrderDateTime(value: string | null | undefined): string {
  return value ? formatManilaDateTime(value) : ORDER_DATE_FALLBACK;
}

/**
 * Normalizes customer name for grouping and comparisons:
 * trims leading/trailing spaces, collapses multiple internal spaces, and converts to lowercase.
 */
export function normalizeCustomerName(name: string | null | undefined): string {
  if (!name) return "";
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}
