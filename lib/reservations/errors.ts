export type ReservationError = {
  message: string;
  field?: "customerId" | "items" | "reservationDiscount" | "downpayment";
};

export function mapReservationDatabaseError(
  databaseMessage: string,
): ReservationError {
  if (databaseMessage.includes("stale_reservation")) {
    return {
      message:
        "This reservation was changed in another session. Reload before saving again.",
    };
  }

  if (databaseMessage.includes("customer_unavailable")) {
    return {
      message: "Select an active customer.",
      field: "customerId",
    };
  }

  if (databaseMessage.includes("stock_item_unavailable")) {
    return {
      message: "One or more selected stock items are no longer available.",
      field: "items",
    };
  }

  if (databaseMessage.includes("duplicate_stock_item")) {
    return {
      message: "Each stock item can only appear once in a reservation.",
      field: "items",
    };
  }

  if (databaseMessage.includes("line_discount_exceeds_subtotal")) {
    return {
      message: "A line discount cannot exceed that item's subtotal.",
      field: "items",
    };
  }

  if (databaseMessage.includes("reservation_discount_exceeds_subtotal")) {
    return {
      message: "Reservation discount cannot exceed the subtotal.",
      field: "reservationDiscount",
    };
  }

  if (databaseMessage.includes("downpayment_exceeds_total")) {
    return {
      message: "Downpayment cannot exceed the reservation total.",
      field: "downpayment",
    };
  }

  if (
    databaseMessage.includes("reservation_not_editable") ||
    databaseMessage.includes("reservation_not_archivable") ||
    databaseMessage.includes("reservation_not_restorable")
  ) {
    return { message: "This reservation cannot be changed in its current state." };
  }

  if (
    databaseMessage.includes("invalid_status_transition") ||
    databaseMessage.includes("invalid_status") ||
    databaseMessage.includes("reservation_archived")
  ) {
    return {
      message: "That status change is not allowed for this reservation.",
    };
  }

  return {
    message: "The reservation could not be saved. Please review it and try again.",
  };
}
