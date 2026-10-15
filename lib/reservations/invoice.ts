import type { ReservationStatus } from "@/types/database";

export const INVOICE_STATUS_LABELS: Record<ReservationStatus, string> = {
  reserved: "Reserved",
  paid: "Paid",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export function getInvoiceStatusLabel(status: ReservationStatus): string {
  return INVOICE_STATUS_LABELS[status];
}

export function getInvoiceTotals(reservation: {
  subtotal: number | string;
  discount: number | string;
  total: number | string;
  downpayment: number | string;
  balance: number | string;
}, paymentTotal?: number) {
  const total = Number(reservation.total);
  const amountPaid = paymentTotal ?? 0;
  return {
    subtotal: Number(reservation.subtotal),
    reservationDiscount: Number(reservation.discount),
    total,
    amountPaid,
    balance: Math.max(total - amountPaid, 0),
  };
}
