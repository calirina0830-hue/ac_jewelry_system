"use server";

import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import { authorizeRoles } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  cancelShipmentSchema,
  orderedAtSchema,
  prepareReleaseSchema,
  releaseItemsSchema,
  shipmentIdSchema,
} from "@/lib/validation/shipments";

const WRITE_ROLES = ["admin", "staff"] as const;
const VIEW_ROLES = ["admin", "staff", "viewer"] as const;

export type ShipmentMutationResult = {
  status: "success" | "error";
  message: string;
  shipmentId?: string;
  shipmentNo?: string;
  itemCount?: number;
  totalQuantity?: number;
};

export type ReleaseFinancialSummaryResult = {
  status: "success" | "error";
  message: string;
  paidAmount: number;
  usedDownpayment: number;
  reservedDownpayment: number;
  remainingUnapplied: number;
};

function revalidateReservation(id: string) {
  revalidatePath("/reservations");
  revalidatePath("/reservations/" + id);
  revalidatePath("/reservations/" + id + "/invoice");
  revalidatePath("/dashboard");
}

function shipmentErrorMessage(message: string): string {
  if (message.includes("insufficient_shipment_quantity")) {
    return "One or more items no longer have that many units available to ship.";
  }
  if (message.includes("insufficient_release_quantity")) {
    return "One or more items no longer have that many units available to release.";
  }
  if (message.includes("duplicate_shipment_item")) {
    return "Each item can only appear once in a shipment.";
  }
  if (message.includes("duplicate_release_item")) {
    return "Each item can only appear once in a release.";
  }
  if (message.includes("reservation_not_shippable")) {
    return "This reservation cannot be shipped in its current state.";
  }
  if (message.includes("reservation_not_releasable")) {
    return "This reservation cannot release items in its current state.";
  }
  if (message.includes("shipment_item_not_found")) {
    return "One of the selected items is no longer on this reservation.";
  }
  if (message.includes("release_item_not_found")) {
    return "One of the selected items is no longer on this reservation.";
  }
  if (message.includes("invalid_shipment_transition")) {
    return "This shipment has already been processed.";
  }
  if (message.includes("insufficient_downpayment")) {
    return "That downpayment is no longer available to apply.";
  }
  if (message.includes("downpayment_exceeds_released_value")) {
    return "The downpayment to apply cannot exceed the value of the released items.";
  }
  if (message.includes("invalid_downpayment_application")) {
    return "Enter a valid downpayment amount.";
  }
  return "Unable to complete the shipment action. Please try again.";
}

export async function prepareShipment(
  reservationId: string,
  items: Array<{ reservationItemId: string; quantity: number }>,
  downpaymentApplied?: string,
): Promise<ShipmentMutationResult> {
  const authorization = await authorizeRoles(WRITE_ROLES);
  const parsed = prepareReleaseSchema.safeParse({
    reservationId,
    items,
    downpaymentApplied,
  });

  if (!authorization) {
    return {
      status: "error",
      message: "You do not have permission to create shipments.",
    };
  }
  if (!parsed.success) {
    return {
      status: "error",
      message:
        parsed.error.issues[0]?.message ?? "Review the release selection.",
    };
  }

  const supabase = await createClient();
  const appliedDownpayment = Number(parsed.data.downpaymentApplied);
  const { data, error } = await supabase.rpc("prepare_reservation_shipment", {
    p_reservation_id: parsed.data.reservationId,
    p_items: parsed.data.items.map((item) => ({
      reservation_item_id: item.reservationItemId,
      quantity: item.quantity,
    })),
    p_downpayment_applied: appliedDownpayment,
  });

  if (error || !data) {
    console.error("Shipment preparation failed", error?.code ?? "no-data");
    return {
      status: "error",
      message: shipmentErrorMessage(error?.message ?? ""),
    };
  }

  revalidateReservation(parsed.data.reservationId);
  await logActivity(supabase, {
    action: "shipment_prepared",
    entityType: "reservation",
    entityId: parsed.data.reservationId,
    description: "Prepared shipment " + data.shipmentNo + ".",
    metadata: {
      shipment_id: data.shipmentId,
      shipment_no: data.shipmentNo,
      item_count: data.itemCount,
      total_quantity: data.totalQuantity,
      downpayment_applied: appliedDownpayment,
    },
  });

  return {
    status: "success",
    message: "Shipment " + data.shipmentNo + " prepared.",
    shipmentId: data.shipmentId,
    shipmentNo: data.shipmentNo,
    itemCount: data.itemCount,
    totalQuantity: data.totalQuantity,
  };
}

export async function createItemRelease(
  reservationId: string,
  items: Array<{ reservationItemId: string; quantity: number }>,
  releaseDate: string,
  downpaymentApplied?: string,
  notes?: string,
): Promise<ShipmentMutationResult> {
  const authorization = await authorizeRoles(WRITE_ROLES);
  const parsed = releaseItemsSchema.safeParse({
    reservationId,
    items,
    releaseDate,
    downpaymentApplied,
    notes,
  });

  if (!authorization) {
    return {
      status: "error",
      message: "You do not have permission to release items.",
    };
  }
  if (!parsed.success) {
    return {
      status: "error",
      message:
        parsed.error.issues[0]?.message ?? "Review the release selection.",
    };
  }

  const supabase = await createClient();
  const appliedDownpayment = Number(parsed.data.downpaymentApplied);
  const formattedDate = parsed.data.releaseDate.includes("T")
    ? parsed.data.releaseDate
    : parsed.data.releaseDate + "T12:00:00Z";

  // Use release_reservation_items RPC
  const { data, error } = await supabase.rpc("release_reservation_items", {
    p_reservation_id: parsed.data.reservationId,
    p_items: parsed.data.items.map((item) => ({
      reservation_item_id: item.reservationItemId,
      quantity: item.quantity,
    })),
    p_release_date: formattedDate,
    p_downpayment_applied: appliedDownpayment,
    p_notes: parsed.data.notes ?? null,
  });

  if (error || !data) {
    console.error("Item release failed", error?.code ?? "no-data", error?.message);
    return {
      status: "error",
      message: shipmentErrorMessage(error?.message ?? ""),
    };
  }

  revalidateReservation(parsed.data.reservationId);
  await logActivity(supabase, {
    action: "item_release_confirmed",
    entityType: "reservation",
    entityId: parsed.data.reservationId,
    description: "Released items under shipment " + data.shipmentNo + ".",
    metadata: {
      shipment_id: data.shipmentId,
      shipment_no: data.shipmentNo,
      item_count: data.itemCount,
      total_quantity: data.totalQuantity,
      downpayment_applied: appliedDownpayment,
      release_date: formattedDate,
      notes: parsed.data.notes ?? null,
    },
  });

  return {
    status: "success",
    message: "Release " + data.shipmentNo + " successfully processed.",
    shipmentId: data.shipmentId,
    shipmentNo: data.shipmentNo,
    itemCount: data.itemCount,
    totalQuantity: data.totalQuantity,
  };
}

export async function getReleaseFinancialSummary(
  reservationId: string,
): Promise<ReleaseFinancialSummaryResult> {
  const authorization = await authorizeRoles(VIEW_ROLES);
  const parsed = shipmentIdSchema.safeParse(reservationId);

  if (!authorization) {
    return {
      status: "error",
      message: "You do not have permission to view shipment finances.",
      paidAmount: 0,
      usedDownpayment: 0,
      reservedDownpayment: 0,
      remainingUnapplied: 0,
    };
  }
  if (!parsed.success) {
    return {
      status: "error",
      message: "Invalid reservation.",
      paidAmount: 0,
      usedDownpayment: 0,
      reservedDownpayment: 0,
      remainingUnapplied: 0,
    };
  }

  const supabase = await createClient();
  const [reservation, payments, shipments] = await Promise.all([
    supabase
      .from("reservations")
      .select("downpayment")
      .eq("id", parsed.data)
      .maybeSingle(),
    supabase
      .from("reservation_payments")
      .select("amount")
      .eq("reservation_id", parsed.data)
      .is("voided_at", null),
    supabase
      .from("reservation_shipments")
      .select("status, downpayment_applied")
      .eq("reservation_id", parsed.data),
  ]);

  if (reservation.error || payments.error || shipments.error) {
    console.error(
      "Release financial summary failed",
      reservation.error?.code ?? payments.error?.code ?? shipments.error?.code ?? "no-data",
    );
    return {
      status: "error",
      message: "Unable to load the release financial summary.",
      paidAmount: 0,
      usedDownpayment: 0,
      reservedDownpayment: 0,
      remainingUnapplied: 0,
    };
  }

  const paymentRows = payments.data ?? [];
  const ledgerPaid = paymentRows.reduce((sum, row) => sum + row.amount, 0);
  const paidAmount =
    paymentRows.length > 0
      ? ledgerPaid
      : Number(reservation.data?.downpayment ?? 0);

  const usedDownpayment = (shipments.data ?? [])
    .filter((shipment) => shipment.status === "shipped")
    .reduce((sum, shipment) => sum + shipment.downpayment_applied, 0);
  const reservedDownpayment = (shipments.data ?? [])
    .filter((shipment) => shipment.status === "pending")
    .reduce((sum, shipment) => sum + shipment.downpayment_applied, 0);

  return {
    status: "success",
    message: "ok",
    paidAmount,
    usedDownpayment,
    reservedDownpayment,
    remainingUnapplied: Math.max(
      paidAmount - usedDownpayment - reservedDownpayment,
      0,
    ),
  };
}

export async function confirmShipment(
  reservationId: string,
  shipmentId: string,
): Promise<ShipmentMutationResult> {
  const authorization = await authorizeRoles(WRITE_ROLES);
  if (!authorization) {
    return {
      status: "error",
      message: "You do not have permission to confirm shipments.",
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("confirm_reservation_shipment", {
    p_shipment_id: shipmentId,
  });

  if (error || !data) {
    console.error("Shipment confirmation failed", error?.code ?? "no-data");
    return {
      status: "error",
      message: shipmentErrorMessage(error?.message ?? ""),
    };
  }

  revalidateReservation(reservationId);
  await logActivity(supabase, {
    action: "shipment_confirmed",
    entityType: "reservation",
    entityId: reservationId,
    description: "Confirmed shipment " + data.shipmentNo + " as shipped.",
    metadata: { shipment_id: shipmentId, shipment_no: data.shipmentNo },
  });

  return {
    status: "success",
    message: "Shipment " + data.shipmentNo + " marked as shipped.",
  };
}

export async function cancelShipment(
  reservationId: string,
  shipmentId: string,
  reason: string,
): Promise<ShipmentMutationResult> {
  const authorization = await authorizeRoles(WRITE_ROLES);
  const parsed = cancelShipmentSchema.safeParse({
    reservationId,
    shipmentId,
    reason: reason || undefined,
  });

  if (!authorization) {
    return {
      status: "error",
      message: "You do not have permission to cancel shipments.",
    };
  }
  if (!parsed.success) {
    return { status: "error", message: "Provide a shorter cancellation reason." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("cancel_reservation_shipment", {
    p_shipment_id: parsed.data.shipmentId,
    p_reason: parsed.data.reason ?? null,
  });

  if (error || !data) {
    console.error("Shipment cancellation failed", error?.code ?? "no-data");
    return {
      status: "error",
      message: error?.message.includes("not_authorized")
        ? "Only an admin can cancel a shipment that was already shipped."
        : shipmentErrorMessage(error?.message ?? ""),
    };
  }

  revalidateReservation(parsed.data.reservationId);
  await logActivity(supabase, {
    action: "shipment_cancelled",
    entityType: "reservation",
    entityId: parsed.data.reservationId,
    description: "Cancelled shipment " + data.shipmentNo + ".",
    metadata: {
      shipment_id: parsed.data.shipmentId,
      shipment_no: data.shipmentNo,
      reason: parsed.data.reason ?? null,
    },
  });

  return {
    status: "success",
    message: "Shipment " + data.shipmentNo + " cancelled.",
  };
}

export async function setReservationItemOrderedAt(
  reservationId: string,
  reservationItemId: string,
  orderedAt: string,
): Promise<ShipmentMutationResult> {
  const authorization = await authorizeRoles(["admin"]);
  const parsed = orderedAtSchema.safeParse({
    reservationId,
    reservationItemId,
    orderedAt,
  });

  if (!authorization) {
    return {
      status: "error",
      message: "Only an admin can correct an item's order date.",
    };
  }
  if (!parsed.success) {
    return { status: "error", message: "Choose a valid order date and time." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_reservation_item_ordered_at", {
    p_reservation_item_id: parsed.data.reservationItemId,
    p_ordered_at: parsed.data.orderedAt,
  });

  if (error) {
    console.error("Order date correction failed", error.code);
    return {
      status: "error",
      message: error.message.includes("invalid_ordered_at")
        ? "Order dates cannot be in the future."
        : "Unable to save the order date.",
    };
  }

  revalidateReservation(parsed.data.reservationId);
  await logActivity(supabase, {
    action: "reservation_item_order_date_corrected",
    entityType: "reservation",
    entityId: parsed.data.reservationId,
    description: "Corrected an item's order date.",
    metadata: { reservation_item_id: parsed.data.reservationItemId },
  });

  return { status: "success", message: "Order date saved." };
}
