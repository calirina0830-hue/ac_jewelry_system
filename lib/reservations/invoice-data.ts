import { BUSINESS } from "@/lib/constants/business";
import {
  getInvoiceStatusLabel,
  getInvoiceTotals,
} from "@/lib/reservations/invoice";
import type { InvoiceDocumentInput } from "@/lib/reservations/invoice-document";
import { computeReleaseLedger } from "@/lib/reservations/release";
import type { createClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

export interface LoadedInvoice {
  reservationNo: string;
  document: InvoiceDocumentInput;
}

// Loads one master invoice for PDF rendering. Returns null when the reservation
// does not exist or has no readable line items so callers can 404 cleanly.
export async function loadInvoiceDocument(
  supabase: SupabaseClient,
  reservationId: string,
): Promise<LoadedInvoice | null> {
  const { data: reservation } = await supabase
    .from("reservations")
    .select("*")
    .eq("id", reservationId)
    .maybeSingle();

  if (!reservation) return null;

  // Find any sibling active/reserved reservations belonging to the same customer
  // so all items ordered by the customer appear on the generated invoice document.
  let siblingReservationIds: string[] = [reservation.id];
  let siblingReservations: typeof reservation[] = [];
  if (reservation.customer_id && !reservation.archived_at && reservation.status === "reserved") {
    const { data: siblings } = await supabase
      .from("reservations")
      .select("*")
      .eq("customer_id", reservation.customer_id)
      .eq("status", "reserved")
      .is("archived_at", null)
      .order("created_at");
    if (siblings && siblings.length > 0) {
      siblingReservations = siblings;
      siblingReservationIds = siblings.map((r) => r.id);
    }
  }

  const [
    { data: items },
    { data: payments },
    { data: customer },
    { data: shipments },
  ] = await Promise.all([
    supabase
      .from("reservation_items")
      .select(
        "id, sku, category, item_name, quantity, unit_price, discount, line_total, ordered_at, created_at",
      )
      .in("reservation_id", siblingReservationIds)
      .order("created_at"),
    supabase
      .from("reservation_payments")
      .select("amount, voided_at")
      .in("reservation_id", siblingReservationIds),
    supabase
      .from("customers")
      .select("name, facebook_name, phone, address")
      .eq("id", reservation.customer_id)
      .maybeSingle(),
    supabase
      .from("reservation_shipments")
      .select("id, status, downpayment_applied")
      .in("reservation_id", siblingReservationIds),
  ]);

  if (!items) return null;

  const shipmentIds = shipments?.map((shipment) => shipment.id) ?? [];
  const { data: shipmentItems } =
    shipmentIds.length > 0
      ? await supabase
          .from("reservation_shipment_items")
          .select("shipment_id, reservation_item_id, quantity")
          .in("shipment_id", shipmentIds)
          .order("created_at")
      : { data: [] };

  const paymentTotal = payments?.length
    ? payments
        .filter((payment) => !payment.voided_at)
        .reduce((total, payment) => total + Number(payment.amount), 0)
    : undefined;
  const combinedReservation = siblingReservations.length > 0
    ? {
        ...reservation,
        subtotal: siblingReservations.reduce((sum, r) => sum + Number(r.subtotal), 0),
        discount: siblingReservations.reduce((sum, r) => sum + Number(r.discount), 0),
        total: siblingReservations.reduce((sum, r) => sum + Number(r.total), 0),
        downpayment: siblingReservations.reduce((sum, r) => sum + Number(r.downpayment), 0),
        balance: siblingReservations.reduce((sum, r) => sum + Number(r.balance), 0),
      }
    : reservation;
  const totals = getInvoiceTotals(combinedReservation, paymentTotal);

  const releaseLedger = computeReleaseLedger(
    (items ?? []).map((item) => ({
      id: item.id,
      description: item.sku + " - " + item.item_name + " - " + item.category,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unit_price),
      discount: Number(item.discount ?? 0),
    })),
    (shipments ?? []).map((shipment) => ({
      id: shipment.id,
      status: shipment.status,
      downpayment_applied: Number(shipment.downpayment_applied ?? 0),
    })),
    (shipmentItems ?? []).map((line) => ({
      shipment_id: line.shipment_id,
      reservation_item_id: line.reservation_item_id,
      quantity: Number(line.quantity),
    })),
  );

  const grossTotal = releaseLedger.items.reduce(
    (sum, item) => sum + item.grossValue,
    0,
  );
  const grossRemaining = releaseLedger.items.reduce(
    (sum, item) => sum + item.unitPrice * item.remainingQty,
    0,
  );
  const remainingFraction = grossTotal > 0 ? grossRemaining / grossTotal : 0;
  const remainingReservationDiscount =
    Number(combinedReservation.discount) * remainingFraction;
  const remainingTotal = Math.max(
    releaseLedger.remainingSubtotal - remainingReservationDiscount,
    0,
  );
  const downpaymentCommitted = releaseLedger.downpaymentCommitted;
  const remainingUnapplied = Math.max(
    totals.amountPaid - downpaymentCommitted,
    0,
  );
  const balanceDue = Math.max(remainingTotal - remainingUnapplied, 0);

  const releasedItems = new Set(
    releaseLedger.items
      .filter((item) => item.releasedQty > 0)
      .map((item) => item.id),
  );
  const itemById = new Map((items ?? []).map((row) => [row.id, row]));
  const documentItems: InvoiceDocumentInput["items"] = releaseLedger.items
    .filter((item) => item.remainingQty > 0)
    .map((item) => {
      const row = itemById.get(item.id);
      const itemDate = row?.ordered_at || row?.created_at || reservation.reserved_at || null;
      return {
        description: item.description,
        orderedAt: itemDate,
        quantity: item.remainingQty,
        unitPrice: item.unitPrice,
        lineTotal: item.remainingSubtotal,
        originalQty: item.quantity,
        releasedQty: releasedItems.has(item.id) ? item.releasedQty : undefined,
      };
    });

  return {
    reservationNo: reservation.reservation_no,
    document: {
      business: BUSINESS,
      invoiceNo: reservation.reservation_no,
      invoiceDate: reservation.reserved_at,
      statusLabel: getInvoiceStatusLabel(reservation.status),
      delivered: Boolean(reservation.delivered_at),
      customerName: customer?.name ?? "Not provided",
      facebookName: customer?.facebook_name ?? null,
      phone: customer?.phone ?? null,
      address: customer?.address ?? null,
      notes: reservation.notes,
      items: documentItems,
      totals: {
        subtotal: releaseLedger.remainingSubtotal,
        reservationDiscount: remainingReservationDiscount,
        total: remainingTotal,
        amountPaid: totals.amountPaid,
        balance: balanceDue,
      },
      totalQuantity: releaseLedger.remainingUnits,
      released:
        releaseLedger.releasedUnits > 0
          ? {
              units: releaseLedger.releasedUnits,
              subtotal: releaseLedger.releasedSubtotal,
              downpaymentApplied: downpaymentCommitted,
            }
          : undefined,
      generatedAt: new Date().toISOString(),
    },
  };
}
