import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { authorizeRoles } from "@/lib/auth";
import { BUSINESS } from "@/lib/constants/business";
import { buildShipmentDocDefinition } from "@/lib/reservations/invoice-document";
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
      .select("id, reservation_no, customer_id")
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
    { data: resData },
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
      .from("reservations")
      .select("downpayment")
      .eq("id", reservation.id)
      .maybeSingle(),
  ]);

  const downpaymentAmount = Number(resData?.downpayment ?? 0);
  const totalDownpaymentApplied = (allShipments ?? [])
    .filter((s) => s.status === "shipped")
    .reduce((sum, s) => sum + Number(s.downpayment_applied ?? 0), 0);
  const remainingDownpayment = Math.max(
    downpaymentAmount - totalDownpaymentApplied,
    0,
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
        ? line.sku + " - " + line.item_name + " - " + line.category
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
      reservationNo: reservation.reservation_no,
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
