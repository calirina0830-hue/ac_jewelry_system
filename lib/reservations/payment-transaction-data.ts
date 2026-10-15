import type { createClient } from "@/lib/supabase/server";
import {
  calculatePaymentTransactionSummary,
  type PaymentTransactionSummary,
} from "@/lib/reservations/payment-transaction";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

type PaymentSummaryReservation = {
  id: string;
  total: number | string;
  discount: number | string;
};

export async function loadPaymentTransactionSummaries(
  supabase: ServerSupabaseClient,
  reservations: PaymentSummaryReservation[],
): Promise<Map<string, PaymentTransactionSummary>> {
  const reservationIds = reservations.map((reservation) => reservation.id);
  if (!reservationIds.length) return new Map();

  const [paymentResult, itemResult, shipmentResult] = await Promise.all([
    supabase
      .from("reservation_payments")
      .select("reservation_id, amount")
      .in("reservation_id", reservationIds)
      .is("voided_at", null),
    supabase
      .from("reservation_items")
      .select(
        "id, reservation_id, sku, item_name, category, quantity, unit_price, discount",
      )
      .in("reservation_id", reservationIds)
      .order("created_at"),
    supabase
      .from("reservation_shipments")
      .select("id, reservation_id, status, downpayment_applied")
      .in("reservation_id", reservationIds),
  ]);
  const queryError =
    paymentResult.error ?? itemResult.error ?? shipmentResult.error;
  if (queryError) throw queryError;

  const shipmentIds = (shipmentResult.data ?? []).map(
    (shipment) => shipment.id,
  );
  const shipmentItemResult = shipmentIds.length
    ? await supabase
        .from("reservation_shipment_items")
        .select("shipment_id, reservation_item_id, quantity")
        .in("shipment_id", shipmentIds)
    : { data: [], error: null };
  if (shipmentItemResult.error) throw shipmentItemResult.error;

  return new Map(
    reservations.map((reservation) => [
      reservation.id,
      calculatePaymentTransactionSummary({
        originalTotal: Number(reservation.total),
        reservationDiscount: Number(reservation.discount),
        items: (itemResult.data ?? [])
          .filter((item) => item.reservation_id === reservation.id)
          .map((item) => ({
            id: item.id,
            sku: item.sku,
            itemName: item.item_name,
            category: item.category,
            quantity: Number(item.quantity),
            unitPrice: Number(item.unit_price),
            discount: Number(item.discount ?? 0),
          })),
        shipments: (shipmentResult.data ?? [])
          .filter((shipment) => shipment.reservation_id === reservation.id)
          .map((shipment) => ({
            id: shipment.id,
            status: shipment.status,
            downpaymentApplied: Number(shipment.downpayment_applied ?? 0),
          })),
        shipmentItems: (shipmentItemResult.data ?? []).map((item) => ({
          shipmentId: item.shipment_id,
          reservationItemId: item.reservation_item_id,
          quantity: Number(item.quantity),
        })),
        payments: (paymentResult.data ?? [])
          .filter((payment) => payment.reservation_id === reservation.id)
          .map((payment) => Number(payment.amount)),
      }),
    ]),
  );
}
