type PaymentEligibleReservation = {
  archived_at: string | null;
  balance: number | string;
  pricing_complete: boolean;
  status: string;
  total: number | string;
};

function isActiveReserved(reservation: PaymentEligibleReservation): boolean {
  return reservation.status === "reserved" && !reservation.archived_at;
}

export function canRecordReservationPayment(
  reservation: PaymentEligibleReservation,
): boolean {
  return (
    isActiveReserved(reservation) &&
    reservation.pricing_complete &&
    Number(reservation.balance) > 0
  );
}

export function needsReservationPricing(
  reservation: PaymentEligibleReservation,
): boolean {
  return isActiveReserved(reservation) && !reservation.pricing_complete;
}

export function getPaymentIneligibilityReason(
  reservation: PaymentEligibleReservation,
): string | null {
  if (reservation.archived_at) return "Archived";
  if (reservation.status !== "reserved") return "Not Reserved";
  if (!reservation.pricing_complete) return "Price pending";
  if (Number(reservation.balance) <= 0) return "No remaining balance";
  return null;
}
