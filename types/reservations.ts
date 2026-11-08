export type ReservationCustomerOption = {
  id: string;
  name: string;
  facebookName: string | null;
  phone: string | null;
};

export type ReservationStockOption = {
  id: string;
  sku: string;
  name: string;
  category: string;
  imagePath: string | null;
};

export type ReservationInitialItem = {
  reservationItemId?: string;
  stockItemId: string;
  quantity: number;
  discount: string;
  unitPrice: string;
  priceConfirmed?: boolean;
  itemName: string;
  sku: string;
  category: string;
  imagePath: string | null;
  orderedAt?: string | null;
  // Partly released lines must keep their name.
  nameLocked?: boolean;
};

export type ReservationInitialValue = {
  id: string;
  updatedAt: string;
  customerId: string;
  reservationDiscount: string;
  downpayment: string;
  // Total of active payment records: what the customer has actually paid.
  amountPaid?: string;
  usedDownpayment?: string;
  reservedDownpayment?: string;
  notes: string;
  items: ReservationInitialItem[];
  preservedItems?: ReservationInitialItem[];
};

export type CustomerInvoiceItem = {
  id: string;
  reservationId: string;
  reservationUpdatedAt: string;
  stockItemId: string;
  sku: string;
  itemName: string;
  category: string;
  orderedAt: string | null;
  quantity: number;
  unitPrice: number;
  discount: number;
  lineTotal: number;
  canShip: boolean;
  canRecordPayment: boolean;
  // Set when a prepared release that was never confirmed still holds this
  // item. The item stays on the invoice until that release is confirmed.
  pendingRelease: { shipmentId: string; quantity: number } | null;
};

export type CustomerInvoiceEditor = {
  reservationId: string;
  customerId: string;
  updatedAt: string;
  items: Array<{
    reservationItemId: string;
    stockItemId: string;
    sku: string;
    itemName: string;
    category: string;
    orderedAt: string | null;
    quantity: number;
    unitPrice: number;
    discount: number;
  }>;
};
