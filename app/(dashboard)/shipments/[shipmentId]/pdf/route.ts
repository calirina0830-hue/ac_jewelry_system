import { formatItemLabel } from "@/lib/reservations/item-label";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { authorizeRoles } from "@/lib/auth";
import { BUSINESS } from "@/lib/constants/business";
import { loadCustomerInvoice } from "@/lib/reservations/customer-invoice";
import { buildShipmentDocDefinition } from "@/lib/reservations/invoice-document";
import { calculateRemainingDownpaymentBalance } from "@/lib/reservations/payment-transaction";
import { renderPdf } from "@/lib/reservations/pdf";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const shipmentIdSchema = z.string().uuid();
const SHIPMENT_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  shipped: "Delivered",
  cancelled: "Cancelled",
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ shipmentId: string }> },
) {
  const authorization = await authorizeRoles(["admin", "staff", "viewer"]);
  if (!authorization) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }

  const { shipmentId } = await params;
  const parsedId = shipmentIdSchema.safeParse(shipmentId);
  if (!parsedId.success) {
    return NextResponse.json({ error: "Shipment not found." }, { status: 404 });
  }

  const supabase = await createClient();
  const { data: shipment } = await supabase
    .from("reservation_shipments")
    .select("*")
    .eq("id", parsedId.data)
    .maybeSingle();

  if (!shipment) {
    return NextResponse.json({ error: "Shipment not found." }, { status: 404 });
  }

  const [{ data: reservation }, { data: shipmentItems }] = await Promise.all([
    supabase
      .from("reservations")
      .select("id, customer_id")
      .eq("id", shipment.reservation_id)
      .maybeSingle(),
    supabase
      .from("reservation_shipment_items")
      .select("reservation_item_id, quantity, ordered_at")
      .eq("shipment_id", shipment.id)
      .order("created_at"),
  ]);

  if (!reservation || !shipmentItems) {
    return NextResponse.json({ error: "Shipment not found." }, { status: 404 });
  }

  const itemIds = shipmentItems.map((item) => item.reservation_item_id);
  const [
    { data: lineItems },
    { data: customer },
    { data: staffProfile },
    { data: allShipments },
    { data: payments, error: paymentsError },
  ] = await Promise.all([
    supabase
      .from("reservation_items")
      .select("id, sku, item_name, category, unit_price, discount, quantity")
      .in(
        "id",
        itemIds.length ? itemIds : ["00000000-0000-0000-0000-000000000000"],
      ),
    supabase
      .from("customers")
      .select("name, facebook_name, phone, address")
      .eq("id", reservation.customer_id)
      .maybeSingle(),
    shipment.created_by
      ? supabase
          .from("profiles")
          .select("full_name")
          .eq("id", shipment.created_by)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("reservation_shipments")
      .select("status, downpayment_applied")
      .eq("reservation_id", reservation.id),
    supabase
      .from("reservation_payments")
      .select("amount")
      .eq("reservation_id", reservation.id)
      .is("voided_at", null),
  ]);

  if (paymentsError) {
    console.error("Failed to load delivery invoice payment records.", paymentsError);
    return NextResponse.json(
      { error: "Unable to load delivery invoice payment data." },
      { status: 500 },
    );
  }

  const totalPaid = (payments ?? []).reduce(
    (total, payment) => total + Number(payment.amount),
    0,
  );
  // The customer's downpayment is one figure across their open orders. Once
  // nothing is left to release there is no invoice, so use this order's own.
  const customerInvoice = customer?.name
    ? await loadCustomerInvoice(supabase, customer.name)
    : null;
  const remainingDownpayment =
    customerInvoice?.availableDownpayment ??
    calculateRemainingDownpaymentBalance(
      totalPaid,
      (allShipments ?? []).map((shipment) => ({
        status: shipment.status,
        downpaymentApplied: Number(shipment.downpayment_applied ?? 0),
      })),
    );

  const lineById = new Map((lineItems ?? []).map((line) => [line.id, line]));
  const items = shipmentItems.map((item) => {
    const line = lineById.get(item.reservation_item_id);
    const quantity = Number(item.quantity);
    const unitPrice = Number(line?.unit_price ?? 0);
    const discount = Number(line?.discount ?? 0);
    const lineQuantity = Number(line?.quantity ?? 0);
    const proratedDiscount =
      discount > 0 && lineQuantity > 0
        ? (discount * quantity) / lineQuantity
        : 0;
    return {
      description: line
        ? formatItemLabel({ sku: line.sku, name: line.item_name, category: line.category })
        : "Item no longer available",
      orderedAt: item.ordered_at,
      quantity,
      subtotal: Math.round((unitPrice * quantity - proratedDiscount) * 100) / 100,
    };
  });
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);

  const buffer = await renderPdf(
    buildShipmentDocDefinition({
      business: BUSINESS,
      shipmentNo: shipment.shipment_no,
      shipmentStatus:
        SHIPMENT_STATUS_LABELS[shipment.status] ?? shipment.status,
      shipmentDate: shipment.created_at,
      shippedAt: shipment.shipped_at,
      customerName: customer?.name ?? "Not provided",
      facebookName: customer?.facebook_name ?? null,
      phone: customer?.phone ?? null,
      address: customer?.address ?? null,
      notes: shipment.notes,
      cancelReason: shipment.cancel_reason,
      downpaymentApplied: Number(shipment.downpayment_applied ?? 0),
      remainingDownpayment,
      staffName: staffProfile?.full_name ?? null,
      items,
      totalQuantity,
      generatedAt: new Date().toISOString(),
    }),
  );

  const inline = request.nextUrl.searchParams.get("view") === "inline";
  await logActivity(supabase, {
    action: inline ? "invoice_viewed" : "shipment_pdf_downloaded",
    entityType: "reservation",
    entityId: reservation.id,
    description: inline
      ? "Viewed delivery invoice " + shipment.shipment_no + "."
      : "Downloaded delivery invoice PDF " + shipment.shipment_no + ".",
  });

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition":
        (inline ? "inline" : "attachment") +
        '; filename="' + shipment.shipment_no + '.pdf"',
      "Content-Type": "application/pdf",
    },
  });
}
