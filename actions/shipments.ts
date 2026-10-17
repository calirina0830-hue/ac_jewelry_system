"use server";

import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import { authorizeRoles } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  cancelShipmentSchema,
  editShipmentSchema,
  orderedAtSchema,
  prepareReleaseSchema,
  releaseItemsSchema,
  shipmentIdSchema,
} from "@/lib/validation/shipments";

const WRITE_ROLES = ["admin", "staff"] as const;
const VIEW_ROLES = ["admin", "staff", "viewer"] as const;

function formatReleaseCurrency(value: number) {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.max(value, 0));
}

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
  revalidatePath("/shipments");
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
  return message && !message.includes("P0001")
    ? message
    : "Unable to complete the shipment action. Please try again.";
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
  const requestedDownpayment = Number(parsed.data.downpaymentApplied);
  const formattedDate = parsed.data.releaseDate.includes("T")
    ? parsed.data.releaseDate
    : parsed.data.releaseDate + "T12:00:00Z";

  // Confirm every selected item belongs to this reservation before releasing it.
  const itemIds = parsed.data.items.map((i) => i.reservationItemId);
  const { data: itemRows, error: itemError } = await supabase
    .from("reservation_items")
    .select("id, reservation_id, unit_price, discount, quantity")
    .in("id", itemIds);

  if (
    itemError ||
    !itemRows ||
    itemRows.length !== itemIds.length ||
    itemRows.some((item) => item.reservation_id !== parsed.data.reservationId)
  ) {
    return {
      status: "error",
      message: "One or more selected items do not belong to this reservation.",
    };
  }

  const itemDetailsMap = new Map(
    itemRows.map((r) => [
      r.id,
      {
        reservationId: r.reservation_id,
        unitPrice: Number(r.unit_price),
        discount: Number(r.discount ?? 0),
        totalQty: Number(r.quantity),
      },
    ]),
  );

  // Group items by their actual reservation_id and calculate total released value per group
  const groupsByResId = new Map<string, Array<{ reservationItemId: string; quantity: number }>>();
  const groupReleasedValueMap = new Map<string, number>();

  for (const item of parsed.data.items) {
    const details = itemDetailsMap.get(item.reservationItemId);
    const actualResId = details?.reservationId ?? parsed.data.reservationId;
    const group = groupsByResId.get(actualResId) ?? [];
    group.push(item);
    groupsByResId.set(actualResId, group);

    const unitPrice = details?.unitPrice ?? 0;
    const discount = details?.discount ?? 0;
    const totalQty = details?.totalQty ?? item.quantity;
    const lineDiscount = totalQty > 0 ? (discount * item.quantity) / totalQty : 0;
    const itemValue = Math.max(unitPrice * item.quantity - lineDiscount, 0);

    const prevValue = groupReleasedValueMap.get(actualResId) ?? 0;
    groupReleasedValueMap.set(actualResId, prevValue + itemValue);
  }

  // Get available downpayment for each reservation in the groups
  const distinctResIds = Array.from(groupsByResId.keys());
  const { data: resRows } = await supabase
    .from("reservations")
    .select("id, downpayment")
    .in("id", distinctResIds);

  const resDownpaymentMap = new Map((resRows ?? []).map((r) => [r.id, Number(r.downpayment)]));

  // Determine available downpayment per reservation
  const availableDownpaymentMap = new Map<string, number>();
  for (const resId of distinctResIds) {
    const { data: committed } = await supabase.rpc("reservation_downpayment_committed", {
      p_reservation_id: resId,
    });
    const totalDownpayment = resDownpaymentMap.get(resId) ?? 0;
    const committedAmount = Number(committed ?? 0);
    availableDownpaymentMap.set(resId, Math.max(totalDownpayment - committedAmount, 0));
  }

  // Distribute requestedDownpayment across the reservations up to their available downpayment
  // AND capped at each group's released value (since DB forbids downpayment > released value)
  let remainingDownpaymentToApply = requestedDownpayment;
  const downpaymentByResId = new Map<string, number>();

  // Prioritize the current reservationId first if it's in the group
  const orderedResIds = [
    ...distinctResIds.filter((id) => id === parsed.data.reservationId),
    ...distinctResIds.filter((id) => id !== parsed.data.reservationId),
  ];

  for (const resId of orderedResIds) {
    const avail = availableDownpaymentMap.get(resId) ?? 0;
    const maxForGroup = groupReleasedValueMap.get(resId) ?? 0;
    const maxApplicable = Math.min(avail, maxForGroup);
    const toApply = Math.min(remainingDownpaymentToApply, maxApplicable);
    downpaymentByResId.set(resId, Math.round(toApply * 100) / 100);
    remainingDownpaymentToApply = Math.max(0, remainingDownpaymentToApply - toApply);
  }

  if (remainingDownpaymentToApply > 0) {
    const maxApplicableTotal = orderedResIds.reduce(
      (total, resId) =>
        total +
        Math.min(
          availableDownpaymentMap.get(resId) ?? 0,
          groupReleasedValueMap.get(resId) ?? 0,
        ),
      0,
    );
    return {
      status: "error",
      message:
        `Only ${formatReleaseCurrency(maxApplicableTotal)} can be applied to this release. Check the available downpayment and selected item value.`,
    };
  }

  const results: Array<{ shipmentId: string; shipmentNo: string; itemCount: number; totalQuantity: number }> = [];

  for (const resId of orderedResIds) {
    const groupItems = groupsByResId.get(resId) ?? [];
    const downpaymentForGroup = downpaymentByResId.get(resId) ?? 0;

    const { data, error } = await supabase.rpc("release_reservation_items", {
      p_reservation_id: resId,
      p_items: groupItems.map((item) => ({
        reservation_item_id: item.reservationItemId,
        quantity: item.quantity,
      })),
      p_release_date: formattedDate,
      p_downpayment_applied: downpaymentForGroup,
      p_notes: parsed.data.notes ?? null,
    });

    let releaseResult: {
      shipmentId: string;
      shipmentNo: string;
      itemCount: number;
      totalQuantity: number;
    } | null = data;

    if (error || !releaseResult) {
      // If the 3-arg prepare_reservation_shipment or release_reservation_items does not exist in the remote database,
      // fall back gracefully to the established prepare_reservation_shipment(uuid, jsonb) and confirm_reservation_shipment
      if (error?.message?.includes("prepare_reservation_shipment") || error?.message?.includes("release_reservation_items")) {
        console.warn("release_reservation_items failed with missing function; executing standard release workflow...");
        const releaseItemsPayload = groupItems.map((item) => ({
          reservation_item_id: item.reservationItemId,
          quantity: item.quantity,
        }));
        // Prefer the downpayment-aware overload so both the shipment and item
        // allocations are persisted by the database function.
        let { data: prepData, error: prepError } = await supabase.rpc("prepare_reservation_shipment", {
          p_reservation_id: resId,
          p_items: releaseItemsPayload,
          p_downpayment_applied: downpaymentForGroup,
        });

        let usedLegacyPrepare = false;
        const prepareErrorText = prepError?.message.toLowerCase() ?? "";
        const downpaymentAwarePrepareMissing =
          prepareErrorText.includes("prepare_reservation_shipment") &&
          (prepareErrorText.includes("schema cache") ||
            prepareErrorText.includes("could not find") ||
            prepareErrorText.includes("does not exist") ||
            prepareErrorText.includes("no function"));

        if (downpaymentAwarePrepareMissing) {
          usedLegacyPrepare = true;
          const legacyPrepare = await supabase.rpc("prepare_reservation_shipment", {
            p_reservation_id: resId,
            p_items: releaseItemsPayload,
          });
          prepData = legacyPrepare.data;
          prepError = legacyPrepare.error;
        }

        if (prepError || !prepData) {
          console.error("Fallback prepare_reservation_shipment failed for " + resId, prepError);
          return {
            status: "error",
            message: shipmentErrorMessage(prepError?.message ?? ""),
          };
        }

        if (usedLegacyPrepare && downpaymentForGroup > 0) {
          const { data: updatedShipment, error: downpaymentUpdateError } =
            await supabase
              .from("reservation_shipments")
              .update({ downpayment_applied: downpaymentForGroup })
              .eq("id", prepData.shipmentId)
              .select("id")
              .maybeSingle();

          if (downpaymentUpdateError || !updatedShipment) {
            console.error(
              "Fallback shipment downpayment update failed for " + resId,
              downpaymentUpdateError?.code ?? "no-row-updated",
            );
            return {
              status: "error",
              message: "The release was prepared, but its downpayment could not be saved. Please retry or cancel the pending release.",
            };
          }
        }

        // 2. Confirm the prepared shipment
        const { data: confirmData, error: confirmError } = await supabase.rpc("confirm_reservation_shipment", {
          p_shipment_id: prepData.shipmentId,
        });

        if (confirmError || !confirmData) {
          console.error("Fallback confirm_reservation_shipment failed for " + resId, confirmError);
          return {
            status: "error",
            message: shipmentErrorMessage(confirmError?.message ?? ""),
          };
        }

        // 3. Persist the custom release date and notes after confirmation.
        const { data: updatedShipment, error: shipmentUpdateError } = await supabase
          .from("reservation_shipments")
          .update({
            shipped_at: formattedDate,
            notes: parsed.data.notes ?? null,
          })
          .eq("id", prepData.shipmentId)
          .select("id")
          .maybeSingle();

        if (shipmentUpdateError || !updatedShipment) {
          console.error(
            "Fallback shipment update failed for " + resId,
            shipmentUpdateError?.code ?? "no-row-updated",
          );
          return {
            status: "error",
            message: "The release was confirmed, but its release details could not be updated.",
          };
        }

        releaseResult = {
          shipmentId: prepData.shipmentId,
          shipmentNo: prepData.shipmentNo,
          itemCount: prepData.itemCount,
          totalQuantity: prepData.totalQuantity,
        };
      } else {
        console.error("Item release failed for reservation " + resId, error);
        const friendlyMsg = shipmentErrorMessage(error?.message ?? "");
        return {
          status: "error",
          message:
            friendlyMsg !== "Unable to complete the shipment action. Please try again."
              ? friendlyMsg
              : (error?.message ? `Unable to release items: ${error.message}` : "Unable to complete the shipment action. Please try again."),
        };
      }
    }

    if (!releaseResult) {
      return {
        status: "error",
        message: "Unable to complete item release.",
      };
    }

    results.push({
      shipmentId: releaseResult.shipmentId,
      shipmentNo: releaseResult.shipmentNo,
      itemCount: releaseResult.itemCount,
      totalQuantity: releaseResult.totalQuantity,
    });

    // A successful item release is treated as a delivered handover. The
    // transition RPC preserves the financial status (reserved/paid) while
    // recording delivered_at, so partial-payment balances remain unchanged.
    const { data: currentReservation, error: reservationLookupError } =
      await supabase
        .from("reservations")
        .select("status, delivered_at, updated_at")
        .eq("id", resId)
        .maybeSingle();

    if (
      !reservationLookupError &&
      currentReservation &&
      !currentReservation.delivered_at &&
      (currentReservation.status === "reserved" ||
        currentReservation.status === "paid")
    ) {
      const { error: deliveryError } = await supabase.rpc(
        "transition_reservation_status",
        {
          p_reservation_id: resId,
          p_new_status: "delivered",
          p_expected_updated_at: currentReservation.updated_at,
        },
      );

      if (deliveryError) {
        console.error(
          "Release succeeded but automatic delivery marking failed for " + resId,
          deliveryError.code,
        );
      }
    }

    revalidateReservation(resId);
    await logActivity(supabase, {
      action: "item_release_confirmed",
      entityType: "reservation",
      entityId: resId,
      description: "Released items under shipment " + releaseResult.shipmentNo + ".",
      metadata: {
        shipment_id: releaseResult.shipmentId,
        shipment_no: releaseResult.shipmentNo,
        item_count: releaseResult.itemCount,
        total_quantity: releaseResult.totalQuantity,
        downpayment_applied: downpaymentForGroup,
        release_date: formattedDate,
        notes: parsed.data.notes ?? null,
      },
    });
  }

  // Revalidate initial reservation as well in case it wasn't in orderedResIds
  revalidateReservation(parsed.data.reservationId);

  const totalItems = results.reduce((sum, r) => sum + r.itemCount, 0);
  const totalQty = results.reduce((sum, r) => sum + r.totalQuantity, 0);
  const shipmentNos = results.map((r) => r.shipmentNo).join(", ");

  return {
    status: "success",
    message: "Release " + shipmentNos + " successfully processed.",
    shipmentId: results[0]?.shipmentId,
    shipmentNo: shipmentNos,
    itemCount: totalItems,
    totalQuantity: totalQty,
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

export async function editShipmentDetails(
  reservationId: string,
  shipmentId: string,
  expectedUpdatedAt: string,
  shippedAt: string,
  notes: string,
  correctionReason: string,
): Promise<ShipmentMutationResult> {
  const authorization = await authorizeRoles(WRITE_ROLES);
  const parsed = editShipmentSchema.safeParse({
    reservationId,
    shipmentId,
    expectedUpdatedAt,
    shippedAt,
    notes,
    correctionReason,
  });

  if (!authorization) {
    return {
      status: "error",
      message: "You do not have permission to edit releases.",
    };
  }
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Review the release correction.",
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("edit_reservation_shipment", {
    p_shipment_id: parsed.data.shipmentId,
    p_expected_updated_at: parsed.data.expectedUpdatedAt,
    p_shipped_at: parsed.data.shippedAt,
    p_notes: parsed.data.notes || null,
    p_correction_reason: parsed.data.correctionReason,
  });

  if (error || !data) {
    console.error("Release correction failed", error?.code ?? "no-data");
    const message = error?.message ?? "";
    return {
      status: "error",
      message: message.includes("stale_shipment")
        ? "This release was changed by someone else. Refresh and try again."
        : message.includes("shipment_not_editable")
          ? "Only an active delivered release can be corrected."
          : shipmentErrorMessage(message),
    };
  }

  revalidateReservation(parsed.data.reservationId);
  await logActivity(supabase, {
    action: "shipment_corrected",
    entityType: "reservation_shipment",
    entityId: parsed.data.shipmentId,
    description: "Corrected release " + data.shipmentNo + ".",
    metadata: {
      reservation_id: parsed.data.reservationId,
      shipment_id: parsed.data.shipmentId,
      shipment_no: data.shipmentNo,
      shipped_at: parsed.data.shippedAt,
      correction_reason: parsed.data.correctionReason,
    },
  });

  return {
    status: "success",
    message: "Release " + data.shipmentNo + " corrected.",
    shipmentId: data.shipmentId,
    shipmentNo: data.shipmentNo,
  };
}

export async function voidShipment(
  reservationId: string,
  shipmentId: string,
  reason: string,
): Promise<ShipmentMutationResult> {
  const authorization = await authorizeRoles(WRITE_ROLES);
  const parsed = editShipmentSchema.shape.correctionReason.safeParse(reason);

  if (!authorization) {
    return {
      status: "error",
      message: "You do not have permission to void releases.",
    };
  }
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Enter a void reason.",
    };
  }

  const shipmentParsed = shipmentIdSchema.safeParse(shipmentId);
  const reservationParsed = shipmentIdSchema.safeParse(reservationId);
  if (!shipmentParsed.success || !reservationParsed.success) {
    return { status: "error", message: "Invalid release." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("cancel_reservation_shipment", {
    p_shipment_id: shipmentParsed.data,
    p_reason: parsed.data,
  });

  if (error || !data) {
    console.error("Release void failed", error?.code ?? "no-data");
    return {
      status: "error",
      message: error?.message?.includes("not_authorized")
        ? "Only an admin can void a delivered release."
        : shipmentErrorMessage(error?.message ?? ""),
    };
  }

  revalidateReservation(reservationParsed.data);
  await logActivity(supabase, {
    action: "shipment_voided",
    entityType: "reservation_shipment",
    entityId: shipmentParsed.data,
    description: "Voided release " + data.shipmentNo + ".",
    metadata: {
      reservation_id: reservationParsed.data,
      shipment_id: shipmentParsed.data,
      shipment_no: data.shipmentNo,
      void_reason: parsed.data,
    },
  });

  return {
    status: "success",
    message: "Release " + data.shipmentNo + " voided.",
    shipmentId: data.shipmentId,
    shipmentNo: data.shipmentNo,
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
