export const RESERVATION_STATUSES = [
  "reserved",
  "paid",
  "delivered",
  "cancelled",
] as const;

export const RESERVATION_STATUS_OPTIONS = [
  { value: "reserved", label: "Reserved" },
  { value: "partially-paid", label: "Partially Paid" },
  { value: "paid", label: "Paid" },
  { value: "delivered", label: "Delivered" },
  { value: "settled", label: "Settled Orders" },
  { value: "cancelled", label: "Cancelled" },
] as const;

export const MAX_RESERVATION_ITEMS = 500;
export const MAX_MONEY_CENTS = 999_999_999_999;
