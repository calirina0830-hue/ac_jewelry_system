import type { CustomerInvoice } from "@/lib/reservations/customer-invoice";

// The value of the quantities about to be released, after line and order
// discounts, using the same shares the invoice applies afterwards.
export function getReleaseValue(
  invoice: CustomerInvoice,
  lines: Array<{ item: CustomerInvoice["items"][number]; quantity: number }>,
): number {
  let value = 0;
  for (const { item, quantity } of lines) {
    if (item.quantity <= 0) continue;
    const reservation = invoice.reservations.find((r) => r.id === item.reservationId);
    const orderDiscount =
      reservation && reservation.remainingGross > 0
        ? reservation.remainingDiscount *
          ((item.unitPrice * quantity) / reservation.remainingGross)
        : 0;
    value += item.lineTotal * (quantity / item.quantity) - orderDiscount;
  }
  return Math.max(value, 0);
}

export function selectCustomerInvoiceItems(
  invoice: CustomerInvoice,
  selectedItemIds?: string[],
): CustomerInvoice {
  if (!selectedItemIds) return invoice;

  const selectedIds = new Set(selectedItemIds);
  const items = invoice.items.filter((item) => selectedIds.has(item.id));
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);

  // A discount belongs to one order, so each order's share comes from that
  // order's own selected items.
  let discount = 0;
  for (const reservation of invoice.reservations) {
    if (reservation.remainingGross <= 0) continue;
    const selectedGross = items
      .filter((item) => item.reservationId === reservation.id)
      .reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    discount +=
      reservation.remainingDiscount * (selectedGross / reservation.remainingGross);
  }

  const total = Math.max(subtotal - discount, 0);
  // The downpayment is one figure for the customer, shared by value.
  const paymentRatio = invoice.totals.total > 0
    ? total / invoice.totals.total
    : 0;
  const amountPaid = invoice.totals.amountPaid * paymentRatio;
  const downpayment = invoice.totals.downpayment * paymentRatio;

  return {
    ...invoice,
    items,
    totals: {
      subtotal,
      discount,
      total,
      quantity: items.reduce((sum, item) => sum + item.quantity, 0),
      amountPaid,
      downpayment,
      balance: Math.max(total - amountPaid, 0),
    },
  };
}
