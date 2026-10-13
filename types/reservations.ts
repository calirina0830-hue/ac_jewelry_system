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
};

export type ReservationInitialValue = {
  id: string;
  reservationNo: string;
  updatedAt: string;
  customerId: string;
  reservationDiscount: string;
  downpayment: string;
  notes: string;
  items: ReservationInitialItem[];
};
