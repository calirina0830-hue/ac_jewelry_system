import { getReservationFormOptions } from "@/lib/reservations/form-options";
import type { createClient } from "@/lib/supabase/server";
import type { ReservationInitialValue } from "@/types/reservations";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

type FormOptions = Awaited<ReturnType<typeof getReservationFormOptions>>;

export type ReservationEditData =
  | { status: "not-found" }
  | { status: "not-editable" }
  | {
      status: "ok";
      initialValue: ReservationInitialValue;
      options: FormOptions;
    };

/**
 * Everything the edit form needs for one reservation. Shared by the full edit
 * page and the floating edit window on the reservations list. Callers must
 * check that the user may edit before showing the result.
 */
export async function loadReservationEditData(
  supabase: SupabaseClient,
  reservationId: string,
): Promise<ReservationEditData> {
  // Round 1: the reservation, its items and its releases (with release lines
  // embedded) all load at the same time.
  const [
    { data: reservation },
    { data: items },
    { data: shipments },
    { data: payments },
  ] = await Promise.all([
    supabase
      .from("reservations")
      .select("*")
      .eq("id", reservationId)
      .maybeSingle(),
    supabase
      .from("reservation_items")
      .select("*")
      .eq("reservation_id", reservationId)
      .order("created_at"),
    supabase
      .from("reservation_shipments")
      .select(
        "id, status, downpayment_applied, reservation_shipment_items(shipment_id, reservation_item_id, quantity)",
      )
      .eq("reservation_id", reservationId),
    supabase
      .from("reservation_payments")
      .select("amount")
      .eq("reservation_id", reservationId)
      .is("voided_at", null),
  ]);

  if (!reservation || !items) {
    return { status: "not-found" };
  }

  if (reservation.archived_at || reservation.status !== "reserved") {
    return { status: "not-editable" };
  }

  const shipmentStatusById = new Map(
    (shipments ?? []).map((shipment) => [shipment.id, shipment.status]),
  );
  const shipmentItems = (shipments ?? []).flatMap(
    (shipment) => shipment.reservation_shipment_items ?? [],
  );
  const releasedByItem = new Map<string, number>();
  for (const shipmentItem of shipmentItems ?? []) {
    if (shipmentStatusById.get(shipmentItem.shipment_id) !== "shipped") continue;
    releasedByItem.set(
      shipmentItem.reservation_item_id,
      (releasedByItem.get(shipmentItem.reservation_item_id) ?? 0) +
        Number(shipmentItem.quantity),
    );
  }

  const usedDownpayment = (shipments ?? [])
    .filter((shipment) => shipment.status === "shipped")
    .reduce(
      (total, shipment) => total + Number(shipment.downpayment_applied ?? 0),
      0,
    );
  const reservedDownpayment = (shipments ?? [])
    .filter((shipment) => shipment.status === "pending")
    .reduce(
      (total, shipment) => total + Number(shipment.downpayment_applied ?? 0),
      0,
    );
  const options = await getReservationFormOptions({
    includeCustomerId: reservation.customer_id,
  });

  const combinedDiscount = Number(reservation.discount);
  const combinedDownpayment = Number(reservation.downpayment);

  const toInitialItem = (
    item: (typeof items)[number],
  ): ReservationInitialValue["items"][number] => ({
    reservationItemId: item.id,
    stockItemId: item.stock_item_id,
    quantity: item.quantity,
    discount: Number(item.discount).toFixed(2),
    unitPrice: item.price_confirmed
      ? Number(item.unit_price).toFixed(2)
      : "",
    priceConfirmed: item.price_confirmed,
    itemName: item.item_name,
    sku: item.sku,
    category: item.category ?? "",
    imagePath: item.image_path,
    orderedAt: item.ordered_at ?? item.created_at,
    nameLocked: (releasedByItem.get(item.id) ?? 0) > 0,
  });
  const editableItems = items.filter(
    (item) =>
      Number(item.quantity) - (releasedByItem.get(item.id) ?? 0) > 0,
  );
  const fullyReleasedItems = items.filter(
    (item) =>
      Number(item.quantity) - (releasedByItem.get(item.id) ?? 0) <= 0,
  );

  return {
    status: "ok",
    options,
    initialValue: {
      id: reservation.id,
      updatedAt: reservation.updated_at,
      customerId: reservation.customer_id,
      reservationDiscount: combinedDiscount.toFixed(2),
      downpayment: combinedDownpayment.toFixed(2),
      amountPaid: (
        (payments ?? []).reduce(
          (total, payment) => total + Math.round(Number(payment.amount) * 100),
          0,
        ) / 100
      ).toFixed(2),
      usedDownpayment: usedDownpayment.toFixed(2),
      reservedDownpayment: reservedDownpayment.toFixed(2),
      notes: reservation.notes ?? "",
      items: editableItems.map(toInitialItem),
      preservedItems: fullyReleasedItems.map(toInitialItem),
    },
  };
}
