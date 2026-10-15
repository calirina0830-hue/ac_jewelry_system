type TransactionItem = {
  id: string;
  sku: string;
  itemName: string;
  category: string;
  quantity: number;
  unitPrice: number;
  discount: number;
};

type TransactionShipment = {
  id: string;
  status: "pending" | "shipped" | "cancelled";
  downpaymentApplied: number;
};

type TransactionShipmentItem = {
  shipmentId: string;
  reservationItemId: string;
  quantity: number;
};

export type PaymentTransactionSummary = {
  originalTotal: number;
  remainingItemsSubtotal: number;
  remainingReservationDiscount: number;
  remainingItemsTotal: number;
  totalPaid: number;
  appliedToReleases: number;
  paidTowardRemaining: number;
  remainingBalance: number;
  paymentCount: number;
  items: Array<{
    id: string;
    label: string;
    originalQuantity: number;
    releasedQuantity: number;
    remainingQuantity: number;
    remainingTotal: number;
  }>;
};

function toCents(value: number): number {
  return Math.round(value * 100);
}

function fromCents(value: number): number {
  return value / 100;
}

export function calculatePaymentTransactionSummary({
  originalTotal,
  reservationDiscount,
  items,
  shipments,
  shipmentItems,
  payments,
}: {
  originalTotal: number;
  reservationDiscount: number;
  items: TransactionItem[];
  shipments: TransactionShipment[];
  shipmentItems: TransactionShipmentItem[];
  payments: number[];
}): PaymentTransactionSummary {
  const activeShipmentIds = new Set(
    shipments
      .filter((shipment) => shipment.status !== "cancelled")
      .map((shipment) => shipment.id),
  );
  const releasedByItem = new Map<string, number>();
  for (const line of shipmentItems) {
    if (!activeShipmentIds.has(line.shipmentId)) continue;
    releasedByItem.set(
      line.reservationItemId,
      (releasedByItem.get(line.reservationItemId) ?? 0) + line.quantity,
    );
  }

  let originalGrossCents = 0;
  let remainingGrossCents = 0;
  let remainingSubtotalCents = 0;
  const remainingItems: PaymentTransactionSummary["items"] = [];

  for (const item of items) {
    const originalQuantity = Math.max(Math.trunc(item.quantity), 0);
    const releasedQuantity = Math.min(
      Math.max(releasedByItem.get(item.id) ?? 0, 0),
      originalQuantity,
    );
    const remainingQuantity = Math.max(originalQuantity - releasedQuantity, 0);
    const unitPriceCents = toCents(item.unitPrice);
    const discountCents = toCents(item.discount);
    const originalLineCents = Math.max(
      unitPriceCents * originalQuantity - discountCents,
      0,
    );
    const releasedDiscountCents =
      originalQuantity > 0
        ? Math.round((discountCents * releasedQuantity) / originalQuantity)
        : 0;
    const releasedLineCents = Math.max(
      unitPriceCents * releasedQuantity - releasedDiscountCents,
      0,
    );
    const remainingLineCents = Math.max(
      originalLineCents - releasedLineCents,
      0,
    );

    originalGrossCents += unitPriceCents * originalQuantity;
    remainingGrossCents += unitPriceCents * remainingQuantity;
    remainingSubtotalCents += remainingLineCents;

    if (remainingQuantity > 0) {
      remainingItems.push({
        id: item.id,
        label: [item.sku, item.itemName, item.category].filter(Boolean).join(" - "),
        originalQuantity,
        releasedQuantity,
        remainingQuantity,
        remainingTotal: fromCents(remainingLineCents),
      });
    }
  }

  const reservationDiscountCents = toCents(reservationDiscount);
  const remainingReservationDiscountCents =
    originalGrossCents > 0
      ? Math.round(
          (reservationDiscountCents * remainingGrossCents) /
            originalGrossCents,
        )
      : 0;
  const remainingItemsTotalCents = Math.max(
    remainingSubtotalCents - remainingReservationDiscountCents,
    0,
  );
  const totalPaidCents = payments.reduce(
    (total, payment) => total + toCents(payment),
    0,
  );
  const appliedToReleasesCents = shipments
    .filter(
      (shipment) =>
        shipment.status === "pending" || shipment.status === "shipped",
    )
    .reduce(
      (total, shipment) => total + toCents(shipment.downpaymentApplied),
      0,
    );
  const paidTowardRemainingCents = Math.max(
    totalPaidCents - appliedToReleasesCents,
    0,
  );

  return {
    originalTotal: fromCents(toCents(originalTotal)),
    remainingItemsSubtotal: fromCents(remainingSubtotalCents),
    remainingReservationDiscount: fromCents(
      remainingReservationDiscountCents,
    ),
    remainingItemsTotal: fromCents(remainingItemsTotalCents),
    totalPaid: fromCents(totalPaidCents),
    appliedToReleases: fromCents(appliedToReleasesCents),
    paidTowardRemaining: fromCents(paidTowardRemainingCents),
    remainingBalance: fromCents(
      Math.max(remainingItemsTotalCents - paidTowardRemainingCents, 0),
    ),
    paymentCount: payments.length,
    items: remainingItems,
  };
}
