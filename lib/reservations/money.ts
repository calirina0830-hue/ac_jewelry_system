import { MAX_MONEY_CENTS } from "@/lib/constants/reservations";

const MONEY_PATTERN = /^\d{1,10}(?:\.\d{1,2})?$/;

export type ReservationMoneyItem = {
  unitPriceCents: number;
  quantity: number;
  discountCents: number;
};

export function parseMoneyToCents(value: string | number): number | null {
  const normalized = String(value).trim();

  if (!MONEY_PATTERN.test(normalized)) {
    return null;
  }

  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));

  return Number.isSafeInteger(cents) && cents <= MAX_MONEY_CENTS
    ? cents
    : null;
}

export function centsToDecimal(cents: number): string {
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, "0");
  return whole + "." + fraction;
}

export function calculateReservationTotals(
  items: ReservationMoneyItem[],
  reservationDiscountCents: number,
  downpaymentCents: number,
) {
  const lines = items.map((item) => {
    const lineSubtotalCents = item.unitPriceCents * item.quantity;
    const lineTotalCents = Math.max(
      lineSubtotalCents - item.discountCents,
      0,
    );

    return { lineSubtotalCents, lineTotalCents };
  });
  const subtotalCents = lines.reduce(
    (total, line) => total + line.lineTotalCents,
    0,
  );
  const totalCents = Math.max(subtotalCents - reservationDiscountCents, 0);
  const balanceCents = Math.max(totalCents - downpaymentCents, 0);

  return { lines, subtotalCents, totalCents, balanceCents };
}
