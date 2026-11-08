import type { PaymentTransactionSummary } from "@/lib/reservations/payment-transaction";

// One customer can have several reservations, but is paid as a single entry.
// The database records payments per reservation, so one entered amount is
// split here and each part is then validated by the server as usual.
export type PaymentGroupMember = {
  id: string;
  // Most that can be paid on this reservation.
  capacity: number;
  // Already paid; the most that a deduction can take back.
  paid: number;
};

export type PaymentAllocation = { id: string; cents: number };

const toCents = (value: number) => Math.round(value * 100);

/**
 * Payments fill the oldest reservation first. Deductions come off the newest
 * first. Any excess lands on the last reservation reached, so the server
 * rejects it instead of it silently disappearing.
 */
export function allocateGroupPayment(
  members: PaymentGroupMember[],
  cents: number,
): PaymentAllocation[] {
  if (cents === 0) return [{ id: members[0].id, cents: 0 }];

  const deduction = cents < 0;
  const ordered = deduction ? [...members].reverse() : members;
  const allocations: PaymentAllocation[] = [];
  let left = Math.abs(cents);

  ordered.forEach((member, index) => {
    if (left === 0) return;
    const limit = toCents(deduction ? member.paid : member.capacity);
    const part = index === ordered.length - 1 ? left : Math.min(limit, left);
    if (part === 0) return;
    allocations.push({ id: member.id, cents: deduction ? -part : part });
    left -= part;
  });

  return allocations;
}

/**
 * Turns one customer's single form entry into the per-reservation fields the
 * server expects. Returns the reservations that receive a payment, and which
 * form entry holds the evidence files for each receiving reservation.
 */
export function expandPaymentGroups(
  formData: FormData,
  groups: PaymentGroupMember[][],
): { reservationIds: string[]; evidenceSourceById: Map<string, string> } {
  const reservationIds: string[] = [];
  const evidenceSourceById = new Map<string, string>();

  for (const group of groups) {
    const lead = group[0].id;
    const raw = String(formData.get("amount:" + lead) ?? "").trim();
    const valid = /^-?\d{1,10}(?:\.\d{1,2})?$/.test(raw);
    const allocations = valid
      ? allocateGroupPayment(group, Math.round(Number(raw) * 100))
      : [{ id: lead, cents: 0 }];

    const shared = ["paymentMethod", "referenceNo", "notes"].map(
      (field) => [field, String(formData.get(field + ":" + lead) ?? "")] as const,
    );

    for (const allocation of allocations) {
      // Invalid text goes to the server unchanged, which reports the error.
      formData.set(
        "amount:" + allocation.id,
        valid ? (allocation.cents / 100).toFixed(2) : raw,
      );
      for (const [field, value] of shared) {
        formData.set(field + ":" + allocation.id, value);
      }
      reservationIds.push(allocation.id);
    }
    // Proof of payment is stored once, on the first reservation paid.
    evidenceSourceById.set(allocations[0].id, lead);
  }

  formData.set("reservationIds", JSON.stringify(reservationIds));
  return { reservationIds, evidenceSourceById };
}

export function combinePaymentSummaries(
  summaries: PaymentTransactionSummary[],
): PaymentTransactionSummary {
  const sum = (key: Exclude<keyof PaymentTransactionSummary, "items" | "paymentCount">) =>
    summaries.reduce((total, summary) => total + toCents(summary[key]), 0) / 100;

  return {
    originalTotal: sum("originalTotal"),
    remainingItemsSubtotal: sum("remainingItemsSubtotal"),
    remainingReservationDiscount: sum("remainingReservationDiscount"),
    remainingItemsTotal: sum("remainingItemsTotal"),
    totalPaid: sum("totalPaid"),
    appliedToReleases: sum("appliedToReleases"),
    paidTowardRemaining: sum("paidTowardRemaining"),
    remainingBalance: sum("remainingBalance"),
    paymentCount: summaries.reduce((total, summary) => total + summary.paymentCount, 0),
    items: summaries.flatMap((summary) => summary.items),
  };
}
