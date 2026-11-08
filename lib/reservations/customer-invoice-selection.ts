import type { CustomerInvoice } from "@/lib/reservations/customer-invoice";

export function selectCustomerInvoiceItems(
  invoice: CustomerInvoice,
  selectedItemIds?: string[],
): CustomerInvoice {
  if (!selectedItemIds) return invoice;

  const selectedIds = new Set(selectedItemIds);
  const items = invoice.items.filter((item) => selectedIds.has(item.id));
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const subtotalRatio = invoice.totals.subtotal > 0
    ? subtotal / invoice.totals.subtotal
    : 0;
  const discount = invoice.totals.discount * subtotalRatio;
  const total = Math.max(subtotal - discount, 0);
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
