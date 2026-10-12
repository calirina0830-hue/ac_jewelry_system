export type ReleaseDisplayStatus = "partially_released" | "fully_released";

export function getReleaseDisplayStatus(
  releasedQuantity: number,
  totalQuantity: number,
): ReleaseDisplayStatus | null {
  if (totalQuantity <= 0) {
    return null;
  }
  if (releasedQuantity >= totalQuantity) {
    return "fully_released";
  }
  if (releasedQuantity > 0) {
    return "partially_released";
  }
  return null;
}

export function releaseStatusLabel(
  status: ReleaseDisplayStatus | null,
): string | null {
  if (status === "fully_released") return "Fully Released";
  if (status === "partially_released") return "Partially Released";
  return null;
}

export type ReleaseLedgerItem = {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  grossValue: number;
  releasedQty: number;
  remainingQty: number;
  releasedSubtotal: number;
  remainingSubtotal: number;
};

export type ReleaseLedger = {
  items: ReleaseLedgerItem[];
  releasedUnits: number;
  remainingUnits: number;
  releasedSubtotal: number;
  remainingSubtotal: number;
  downpaymentCommitted: number;
};

// Splits reservation line items into already-released and still-on-hold
// portions so invoices can show only the remaining goods. Downpayment
// "committed" sums what pending + shipped releases have applied (cancelled
// releases never reserve money back into the shop).
export function computeReleaseLedger(
  items: Array<{
    id: string;
    description: string;
    quantity: number;
    unitPrice: number;
    discount: number;
  }>,
  shipments: Array<{
    id: string;
    status: "pending" | "shipped" | "cancelled";
    downpayment_applied: number;
  }>,
  shipmentItems: Array<{
    shipment_id: string;
    reservation_item_id: string;
    quantity: number;
  }>,
): ReleaseLedger {
  const activeShipmentIds = new Set(
    shipments
      .filter((shipment) => shipment.status !== "cancelled")
      .map((shipment) => shipment.id),
  );
  const releasedByItem = new Map<string, number>();
  for (const line of shipmentItems) {
    if (!activeShipmentIds.has(line.shipment_id)) continue;
    releasedByItem.set(
      line.reservation_item_id,
      (releasedByItem.get(line.reservation_item_id) ?? 0) + line.quantity,
    );
  }

  const downpaymentCommitted = shipments
    .filter((shipment) => shipment.status === "pending" || shipment.status === "shipped")
    .reduce(
      (total, shipment) => total + Number(shipment.downpayment_applied ?? 0),
      0,
    );

  const rows = items.map((item) => {
    const releasedQty = Math.min(
      releasedByItem.get(item.id) ?? 0,
      item.quantity,
    );
    const remainingQty = Math.max(item.quantity - releasedQty, 0);
    const fractionOfLine = item.quantity > 0 ? 1 / item.quantity : 0;
    return {
      ...item,
      grossValue: item.unitPrice * item.quantity,
      releasedQty,
      remainingQty,
      releasedSubtotal:
        releasedQty > 0
          ? item.unitPrice * releasedQty -
            item.discount * (releasedQty * fractionOfLine)
          : 0,
      remainingSubtotal:
        remainingQty > 0
          ? item.unitPrice * remainingQty -
            item.discount * (remainingQty * fractionOfLine)
          : 0,
    };
  });

  return {
    items: rows,
    releasedUnits: rows.reduce((total, row) => total + row.releasedQty, 0),
    remainingUnits: rows.reduce((total, row) => total + row.remainingQty, 0),
    releasedSubtotal: rows.reduce(
      (total, row) => total + row.releasedSubtotal,
      0,
    ),
    remainingSubtotal: rows.reduce(
      (total, row) => total + row.remainingSubtotal,
      0,
    ),
    downpaymentCommitted,
  };
}