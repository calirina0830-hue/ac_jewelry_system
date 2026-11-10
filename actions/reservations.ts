"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ZodError } from "zod";

import { logActivity } from "@/lib/activity";
import { authorizeRoles } from "@/lib/auth";
import { mapReservationDatabaseError } from "@/lib/reservations/errors";
import {
  MANUAL_ITEM_CATEGORY,
  MANUAL_ITEM_SKU_PREFIX,
} from "@/lib/reservations/item-label";
import { allocateAppliedDownpayment } from "@/lib/reservations/customer-cycle";
import {
  calculateReservationTotals,
  centsToDecimal,
  parseMoneyToCents,
} from "@/lib/reservations/money";
import { canRoleTransitionReservation } from "@/lib/reservations/status";
import { createClient } from "@/lib/supabase/server";
import {
  createReservationSchema,
  reservationInvoiceNotesSchema,
  reservationInvoiceItemsSchema,
  reservationIdSchema,
  reservationStatusTransitionSchema,
  updateReservationSchema,
} from "@/lib/validation/reservations";
import type { ReservationStatus } from "@/types/database";
import type { FormActionState } from "@/types/forms";

const WRITE_ROLES = ["admin", "staff", "owner", "developer"] as const;

function getTextField(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

function getItems(formData: FormData): unknown {
  const value = getTextField(formData, "items");

  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function getReservationFields(formData: FormData) {
  return {
    customerId: getTextField(formData, "customerId"),
    reservationDiscount: getTextField(formData, "reservationDiscount"),
    downpayment: getTextField(formData, "downpayment"),
    notes: getTextField(formData, "notes"),
    items: getItems(formData),
  };
}

function getReservationFieldErrors(
  error: ZodError,
): Record<string, string[]> {
  const errors: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const field = issue.path.length ? issue.path.join(".") : "form";
    errors[field] = [...(errors[field] ?? []), issue.message];
  }

  return errors;
}

function unauthorizedState(): FormActionState {
  return {
    status: "error",
    message: "You do not have permission to perform this action.",
  };
}

function databaseErrorState(message: string): FormActionState {
  const mapped = mapReservationDatabaseError(message);

  return {
    status: "error",
    message:
      mapped.message === "The reservation could not be saved. Please review it and try again."
        ? `The reservation could not be saved: ${message}`
        : mapped.message,
    fieldErrors: mapped.field ? { [mapped.field]: [mapped.message] } : undefined,
  };
}

function manualItemSku(name: string): string {
  return (
    MANUAL_ITEM_SKU_PREFIX +
    createHash("sha256").update(name).digest("hex").slice(0, 24)
  );
}

// The database links every order line to a stock_items row and copies the
// name from it. Typed items get a hidden row per distinct name, so the text
// is saved exactly as entered without a product catalog.
async function resolveTypedItems<
  T extends { stockItemId?: string; itemName?: string },
>(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  items: T[],
): Promise<Array<T & { stockItemId: string }> | null> {
  const names = [
    ...new Set(
      items.flatMap((item) => (item.stockItemId ? [] : [item.itemName ?? ""])),
    ),
  ];
  const idByName = new Map<string, string>();

  if (names.length) {
    const nameBySku = new Map(names.map((name) => [manualItemSku(name), name]));
    const findExisting = async () => {
      const { data } = await supabase
        .from("stock_items")
        .select("id, sku")
        .in("sku", [...nameBySku.keys()]);
      for (const row of data ?? []) {
        const name = nameBySku.get(row.sku);
        if (name) idByName.set(name, row.id);
      }
    };

    await findExisting();
    const missing = names.filter((name) => !idByName.has(name));
    if (missing.length) {
      const { error } = await supabase.from("stock_items").upsert(
        missing.map((name) => ({
          sku: manualItemSku(name),
          name,
          category: MANUAL_ITEM_CATEGORY,
          price: 0,
          quantity: 1,
          is_active: true,
          created_by: userId,
        })),
        { onConflict: "sku", ignoreDuplicates: true },
      );
      if (error) {
        console.error("Typed item could not be saved", error.code, error.message);
        return null;
      }
      await findExisting();
    }
    if (names.some((name) => !idByName.has(name))) return null;
  }

  return items.map((item) => ({
    ...item,
    stockItemId: item.stockItemId ?? idByName.get(item.itemName ?? "") ?? "",
  }));
}

const TYPED_ITEM_ERROR: FormActionState = {
  status: "error",
  message: "An item could not be saved. Please try again.",
};

function parseCustomerOrderIds(value: string | undefined, editedId: string): string[] {
  try {
    const list: unknown = JSON.parse(value ?? "[]");
    if (Array.isArray(list)) {
      const ids = list.filter(
        (id): id is string =>
          typeof id === "string" && reservationIdSchema.safeParse(id).success,
      );
      return [...new Set([editedId, ...ids])].slice(0, 100);
    }
  } catch {
    // Fall through: edit this order on its own.
  }
  return [editedId];
}

function normalizeCustomerName(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function toRpcItems(
  items: Array<{
    reservationItemId?: string;
    stockItemId: string;
    quantity: number;
    sellingPrice: number;
    discount: number;
    orderedAt?: string;
  }>,
) {
  return items.map((item) => ({
    reservation_item_id: item.reservationItemId ?? null,
    stock_item_id: item.stockItemId,
    quantity: item.quantity,
    selling_price: centsToDecimal(item.sellingPrice),
    discount: centsToDecimal(item.discount),
    ordered_at: item.orderedAt ?? null,
  }));
}

function revalidateReservationPaths(id?: string) {
  revalidatePath("/reservations");
  if (id) {
    revalidatePath("/reservations/" + id);
    revalidatePath("/reservations/" + id + "/invoice");
  }
}

const STATUS_ACTIVITY_ACTIONS: Record<ReservationStatus, string> = {
  reserved: "reservation_reverted_to_reserved",
  paid: "reservation_marked_paid",
  delivered: "reservation_delivered",
  cancelled: "reservation_cancelled",
};

export async function createReservation(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const authorization = await authorizeRoles(WRITE_ROLES);

  if (!authorization) {
    return unauthorizedState();
  }

  const parsed = createReservationSchema.safeParse(
    getReservationFields(formData),
  );

  if (!parsed.success) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      fieldErrors: getReservationFieldErrors(parsed.error),
    };
  }

  const supabase = await createClient();
  const resolvedItems = await resolveTypedItems(
    supabase,
    authorization.user.id,
    parsed.data.items,
  );
  if (!resolvedItems) {
    return TYPED_ITEM_ERROR;
  }

  const { data: reservationId, error } = await supabase.rpc(
    "create_reservation_with_downpayment",
    {
      p_customer_id: parsed.data.customerId,
      p_discount: centsToDecimal(parsed.data.reservationDiscount),
      p_downpayment: centsToDecimal(parsed.data.downpayment),
      p_notes: parsed.data.notes,
      p_items: toRpcItems(resolvedItems),
    },
  );

  if (error || !reservationId) {
    console.error("Reservation creation failed", error?.code ?? "no-id");
    return databaseErrorState(error?.message ?? "reservation_create_failed");
  }

  revalidateReservationPaths(reservationId);
  await logActivity(supabase, {
    action: "reservation_created",
    entityType: "reservation",
    entityId: reservationId,
    description: "Created reservation.",
    metadata: { customer_id: parsed.data.customerId },
  });
  redirect("/reservations?message=created");
}

export async function updateReservation(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const authorization = await authorizeRoles(WRITE_ROLES);

  if (!authorization) {
    return unauthorizedState();
  }

  const parsed = updateReservationSchema.safeParse({
    id: getTextField(formData, "id"),
    updatedAt: getTextField(formData, "updatedAt"),
    ...getReservationFields(formData),
  });

  if (!parsed.success) {
    const fieldErrors = getReservationFieldErrors(parsed.error);
    const hiddenFieldError =
      fieldErrors.id?.[0] ?? fieldErrors.updatedAt?.[0];

    return {
      status: "error",
      message: hiddenFieldError ?? "Please correct the highlighted fields.",
      fieldErrors,
    };
  }

  const supabase = await createClient();
  const resolvedItems = await resolveTypedItems(
    supabase,
    authorization.user.id,
    parsed.data.items,
  );
  if (!resolvedItems) {
    return TYPED_ITEM_ERROR;
  }

  // The Downpayment box is one figure for the whole customer, matching the
  // customer's single row in the list. Current amounts come from the records,
  // not from what the browser loaded.
  const orderIds = parseCustomerOrderIds(
    getTextField(formData, "customerOrderIds"),
    parsed.data.id,
  );
  const [
    { data: orderRows },
    { data: activePayments, error: paymentsError },
    { data: releases },
  ] = await Promise.all([
    supabase
      .from("reservation_list")
      .select("id, customer_name, total, status, archived_at, reserved_at")
      .in("id", orderIds),
    supabase
      .from("reservation_payments")
      .select("reservation_id, amount")
      .in("reservation_id", orderIds)
      .is("voided_at", null),
    supabase
      .from("reservation_shipments")
      .select("reservation_id, status, downpayment_applied")
      .in("reservation_id", orderIds),
  ]);
  const editedRow = orderRows?.find((row) => row.id === parsed.data.id);
  if (paymentsError || !activePayments || !orderRows || !editedRow) {
    return { status: "error", message: "Unable to read this order's payments. Try again." };
  }

  const { totalCents } = calculateReservationTotals(
    resolvedItems.map((item) => ({
      unitPriceCents: item.sellingPrice,
      quantity: item.quantity,
      discountCents: item.discount,
    })),
    parsed.data.reservationDiscount,
    0,
  );
  const customerOrders = orderRows
    .filter(
      (row) =>
        row.id === parsed.data.id ||
        (row.status === "reserved" &&
          !row.archived_at &&
          normalizeCustomerName(row.customer_name) ===
            normalizeCustomerName(editedRow.customer_name)),
    )
    .sort((a, b) => (a.reserved_at ?? "").localeCompare(b.reserved_at ?? ""))
    .map((row) => ({
      id: row.id,
      status: row.status,
      totalCents:
        row.id === parsed.data.id ? totalCents : Math.round(Number(row.total) * 100),
      paidCents: activePayments
        .filter((payment) => payment.reservation_id === row.id)
        .reduce((sum, payment) => sum + Math.round(Number(payment.amount) * 100), 0),
      committedCents: (releases ?? [])
        .filter(
          (release) =>
            release.reservation_id === row.id &&
            (release.status === "pending" || release.status === "shipped"),
        )
        .reduce(
          (sum, release) => sum + Math.round(Number(release.downpayment_applied ?? 0) * 100),
          0,
        ),
    }));

  const sumOf = (key: "totalCents" | "paidCents" | "committedCents") =>
    customerOrders.reduce((sum, order) => sum + order[key], 0);
  const currentPaidCents = sumOf("paidCents");
  const committedCents = sumOf("committedCents");
  const newPaidCents = parsed.data.downpayment;
  const downpaymentChanged = newPaidCents !== currentPaidCents;

  if (downpaymentChanged && newPaidCents > sumOf("totalCents")) {
    const message = "Downpayment cannot be more than the customer's total.";
    return { status: "error", message, fieldErrors: { downpayment: [message] } };
  }
  if (newPaidCents < currentPaidCents && newPaidCents < committedCents) {
    const message =
      "Downpayment cannot go below " +
      centsToDecimal(committedCents) +
      ", the amount already applied to released items.";
    return { status: "error", message, fieldErrors: { downpayment: [message] } };
  }

  // Released amounts stay on their orders; the rest fills the oldest first.
  let unassignedCents = newPaidCents;
  const allocations = customerOrders.map((order) => {
    const base = Math.min(order.committedCents, order.totalCents);
    unassignedCents -= base;
    return { ...order, newPaidCents: base };
  });
  for (const allocation of allocations) {
    const add = Math.min(
      allocation.totalCents - allocation.newPaidCents,
      Math.max(unassignedCents, 0),
    );
    allocation.newPaidCents += add;
    unassignedCents -= add;
  }
  const editedPaidCents = downpaymentChanged
    ? (allocations.find((order) => order.id === parsed.data.id)?.newPaidCents ?? 0)
    : (allocations.find((order) => order.id === parsed.data.id)?.paidCents ?? 0);
  const editedCommittedCents =
    allocations.find((order) => order.id === parsed.data.id)?.committedCents ?? 0;

  // "Add downpayment" is only the newest payment. It is saved as its own
  // record on top of what was already paid, oldest order first.
  const additionalCents = parseMoneyToCents(
    getTextField(formData, "additionalDownpayment")?.trim() || "0",
  );
  const additionalRooms = allocations.map((order) =>
    order.status === "reserved"
      ? Math.max(
          order.totalCents - (downpaymentChanged ? order.newPaidCents : order.paidCents),
          0,
        )
      : 0,
  );
  const additionalRoomCents = additionalRooms.reduce((sum, room) => sum + room, 0);
  if (additionalCents === null || additionalCents < 0) {
    const message = "Enter a valid amount.";
    return { status: "error", message, fieldErrors: { additionalDownpayment: [message] } };
  }
  if (additionalCents > additionalRoomCents) {
    const message =
      "Add downpayment cannot be more than the balance of " +
      centsToDecimal(additionalRoomCents) +
      ".";
    return { status: "error", message, fieldErrors: { additionalDownpayment: [message] } };
  }

  const { data: reservationId, error } = await supabase.rpc(
    "update_reservation_with_payment_adjustment",
    {
      p_reservation_id: parsed.data.id,
      p_expected_updated_at: parsed.data.updatedAt,
      p_customer_id: parsed.data.customerId,
      p_discount: centsToDecimal(parsed.data.reservationDiscount),
      p_downpayment: centsToDecimal(Math.max(editedPaidCents, editedCommittedCents)),
      p_notes: parsed.data.notes,
      p_items: toRpcItems(resolvedItems),
    },
  );

  if (error || !reservationId) {
    console.error("Reservation update failed:", error?.code, error?.message, error?.details, error?.hint);
    return databaseErrorState(error?.message ?? "reservation_update_failed");
  }

  revalidateReservationPaths(reservationId);
  await logActivity(supabase, {
    action: "reservation_edited",
    entityType: "reservation",
    entityId: reservationId,
    description: "Edited reservation.",
    metadata: { customer_id: parsed.data.customerId },
  });
  // The floating edit window returns to the list it was opened from.
  const requestedReturn = getTextField(formData, "returnTo") ?? "";
  const returnTo = requestedReturn.startsWith("/reservations?")
    ? requestedReturn + "&"
    : "/reservations?";

  // A changed downpayment overwrites the amounts on the payment records, so
  // every total reads the new figure and no extra entry appears.
  if (downpaymentChanged) {
    const changes = allocations
      .filter((order) => order.newPaidCents !== order.paidCents)
      .map((order) => ({ id: order.id, amount: centsToDecimal(order.newPaidCents) }));
    const { error: paymentError } = await supabase.rpc("set_reservation_paid_amounts", {
      p_amounts: changes,
    });
    if (paymentError) {
      console.error("Downpayment change failed:", paymentError.code, paymentError.message);
      redirect(returnTo + "error=downpayment-not-saved");
    }
    revalidateReservationPaths(reservationId);
    await logActivity(supabase, {
      action: "payment_edited",
      entityType: "reservation",
      entityId: reservationId,
      description:
        "Changed the downpayment from " +
        centsToDecimal(currentPaidCents) +
        " to " +
        centsToDecimal(newPaidCents) +
        " in Edit order.",
      metadata: {
        previous_amount: centsToDecimal(currentPaidCents),
        new_amount: centsToDecimal(newPaidCents),
      },
    });
  }

  if (additionalCents > 0) {
    const shares = allocateAppliedDownpayment(additionalRooms, additionalCents);
    for (const [index, order] of allocations.entries()) {
      if (shares[index] <= 0) continue;
      // The save above moved the order's version, so read the current one.
      const { data: current } = await supabase
        .from("reservations")
        .select("updated_at")
        .eq("id", order.id)
        .maybeSingle();
      const { error: paymentError } = current
        ? await supabase.rpc("record_reservation_payment", {
            p_reservation_id: order.id,
            p_expected_updated_at: current.updated_at,
            p_amount: centsToDecimal(shares[index]),
            p_payment_method: null,
            p_reference_no: null,
            p_notes: "Additional downpayment entered in Edit order.",
            p_evidence: [],
          })
        : { error: { code: "not-found", message: "reservation_not_found" } };
      if (paymentError) {
        console.error("Additional downpayment failed:", paymentError.code, paymentError.message);
        redirect(returnTo + "error=downpayment-not-saved");
      }
      await logActivity(supabase, {
        action: "payment_recorded",
        entityType: "reservation",
        entityId: order.id,
        description:
          "Added a downpayment of " + centsToDecimal(shares[index]) + " in Edit order.",
        metadata: { amount: centsToDecimal(shares[index]) },
      });
    }
    revalidateReservationPaths(reservationId);
  }
  redirect(returnTo + "message=updated");
}

export async function transitionReservationStatus(
  id: string,
  newStatus: ReservationStatus,
  expectedUpdatedAt: string,
): Promise<void> {
  const authorization = await authorizeRoles(WRITE_ROLES);
  const parsed = reservationStatusTransitionSchema.safeParse({
    id,
    newStatus,
    updatedAt: expectedUpdatedAt,
  });

  if (!authorization || !parsed.success) {
    redirect("/reservations?error=not-authorized");
  }

  const supabase = await createClient();
  const { data: reservation } = await supabase
    .from("reservations")
    .select("status, archived_at")
    .eq("id", parsed.data.id)
    .maybeSingle();

  if (
    !reservation ||
    reservation.archived_at ||
    !canRoleTransitionReservation(
      authorization.profile.role,
      reservation.status,
      parsed.data.newStatus,
    )
  ) {
    redirect("/reservations?error=invalid-transition");
  }

  const { error } = await supabase.rpc("transition_reservation_status", {
    p_reservation_id: parsed.data.id,
    p_new_status: parsed.data.newStatus,
    p_expected_updated_at: parsed.data.updatedAt,
  });

  if (error) {
    console.error("Reservation status transition failed", error.code);
    const mapped = mapReservationDatabaseError(error.message);
    const errorCode = error.message.includes("stale_reservation")
      ? "stale-reservation"
      : "invalid-transition";
    redirect(
      "/reservations?error=" +
        errorCode +
        "&detail=" +
        encodeURIComponent(mapped.message),
    );
  }

  revalidateReservationPaths(parsed.data.id);
  await logActivity(supabase, {
    action: STATUS_ACTIVITY_ACTIONS[parsed.data.newStatus],
    entityType: "reservation",
    entityId: parsed.data.id,
    description:
      "Changed reservation status to " + parsed.data.newStatus + ".",
    metadata: { new_status: parsed.data.newStatus },
  });
  redirect(
    "/reservations?message=status-" + parsed.data.newStatus,
  );
}

export type InvoiceMutationResult = {
  status: "success" | "error";
  message: string;
};

/**
 * Moves several reservations (one customer's order) to a new status in one
 * step, without leaving the page. Uses the same permission checks and
 * database function as transitionReservationStatus, but returns a result
 * for the caller to show instead of redirecting to the detail page.
 * Reservations that cannot make the move are skipped and reported.
 */
export async function moveReservations(
  reservations: Array<{ id: string; updatedAt: string }>,
  newStatus: ReservationStatus,
): Promise<InvoiceMutationResult> {
  const authorization = await authorizeRoles(WRITE_ROLES);
  if (!authorization) {
    return { status: "error", message: "You do not have permission to change status." };
  }
  if (!reservations.length || reservations.length > 200) {
    return { status: "error", message: "Select between 1 and 200 reservations." };
  }

  const supabase = await createClient();
  let moved = 0;
  const failures: string[] = [];

  for (const entry of reservations) {
    const parsed = reservationStatusTransitionSchema.safeParse({
      id: entry.id,
      newStatus,
      updatedAt: entry.updatedAt,
    });
    if (!parsed.success) {
      failures.push("Invalid reservation.");
      continue;
    }

    const { data: reservation } = await supabase
      .from("reservations")
      .select("status, archived_at")
      .eq("id", parsed.data.id)
      .maybeSingle();
    if (
      !reservation ||
      reservation.archived_at ||
      !canRoleTransitionReservation(
        authorization.profile.role,
        reservation.status,
        parsed.data.newStatus,
      )
    ) {
      failures.push("A reservation cannot be moved.");
      continue;
    }

    const { error } = await supabase.rpc("transition_reservation_status", {
      p_reservation_id: parsed.data.id,
      p_new_status: parsed.data.newStatus,
      p_expected_updated_at: parsed.data.updatedAt,
    });
    if (error) {
      console.error("Reservation status move failed", error.code);
      failures.push(
        mapReservationDatabaseError(error.message).message,
      );
      continue;
    }

    moved += 1;
    await logActivity(supabase, {
      action: STATUS_ACTIVITY_ACTIONS[parsed.data.newStatus],
      entityType: "reservation",
      entityId: parsed.data.id,
      description: "Changed reservation status to " + parsed.data.newStatus + ".",
      metadata: { new_status: parsed.data.newStatus },
    });
    revalidateReservationPaths(parsed.data.id);
  }

  revalidateReservationPaths();
  if (failures.length) {
    return {
      status: "error",
      message:
        (moved ? moved + " moved. " : "") + "Not moved: " + failures.join(" "),
    };
  }
  return {
    status: "success",
    message:
      moved +
      " reservation" +
      (moved === 1 ? "" : "s") +
      " moved to " +
      newStatus +
      ".",
  };
}

export async function markReservationDelivered(
  id: string,
  expectedUpdatedAt: string,
): Promise<InvoiceMutationResult> {
  const authorization = await authorizeRoles(["admin", "staff"]);
  const parsed = reservationStatusTransitionSchema.safeParse({
    id,
    newStatus: "delivered",
    updatedAt: expectedUpdatedAt,
  });

  if (!authorization || !parsed.success) {
    return {
      status: "error",
      message: "You do not have permission to deliver this reservation.",
    };
  }

  const supabase = await createClient();
  const { data: reservation, error: loadError } = await supabase
    .from("reservations")
    .select("status, delivered_at, archived_at")
    .eq("id", parsed.data.id)
    .maybeSingle();

  if (loadError || !reservation) {
    console.error(
      "Reservation delivery lookup failed",
      loadError?.code ?? "not-found",
    );
    return { status: "error", message: "Unable to load this reservation." };
  }
  if (reservation.archived_at || reservation.delivered_at) {
    return {
      status: "error",
      message: reservation.delivered_at
        ? "This reservation has already been delivered."
        : "Archived reservations cannot be delivered.",
    };
  }
  if (
    !canRoleTransitionReservation(
      authorization.profile.role,
      reservation.status,
      "delivered",
    )
  ) {
    return {
      status: "error",
      message: "This reservation cannot be delivered in its current state.",
    };
  }

  const { error } = await supabase.rpc("transition_reservation_status", {
    p_reservation_id: parsed.data.id,
    p_new_status: "delivered",
    p_expected_updated_at: parsed.data.updatedAt,
  });

  if (error) {
    console.error("Reservation delivery failed", error.code);
    const message = error.message.includes("stale_reservation")
      ? "This reservation changed. Refresh the page and try again."
      : error.message.includes("already_delivered")
        ? "This reservation has already been delivered."
        : "Unable to mark this reservation as delivered.";
    return { status: "error", message };
  }

  revalidateReservationPaths(parsed.data.id);
  await logActivity(supabase, {
    action: "reservation_delivered",
    entityType: "reservation",
    entityId: parsed.data.id,
    description: "Marked reservation as delivered.",
  });
  return { status: "success", message: "Reservation marked as delivered." };
}

export async function updateReservationInvoiceNotes(
  id: string,
  expectedUpdatedAt: string,
  notes: string,
): Promise<InvoiceMutationResult> {
  const authorization = await authorizeRoles(["admin", "staff"]);
  const parsed = reservationInvoiceNotesSchema.safeParse({
    id,
    expectedUpdatedAt,
    notes,
  });

  if (!authorization || !parsed.success) {
    return {
      status: "error",
      message: parsed.success
        ? "You do not have permission to update these notes."
        : "Notes must be 4,000 characters or fewer.",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_reservation_invoice_notes", {
    p_reservation_id: parsed.data.id,
    p_expected_updated_at: parsed.data.expectedUpdatedAt,
    p_notes: parsed.data.notes || null,
  });

  if (error) {
    console.error("Reservation invoice notes update failed", error.code);
    return {
      status: "error",
      message: error.message.includes("stale_reservation")
        ? "This reservation changed. Refresh the page and try again."
        : error.message.includes("reservation_archived")
          ? "Archived reservation notes cannot be changed."
          : "Unable to save invoice notes.",
    };
  }

  revalidateReservationPaths(parsed.data.id);
  await logActivity(supabase, {
    action: "reservation_edited",
    entityType: "reservation",
    entityId: parsed.data.id,
    description: "Updated reservation invoice notes.",
  });
  return { status: "success", message: "Notes saved." };
}

export async function updateReservationInvoiceItems(
  id: string,
  expectedUpdatedAt: string,
  items: unknown,
): Promise<InvoiceMutationResult> {
  const authorization = await authorizeRoles(WRITE_ROLES);
  const parsed = reservationInvoiceItemsSchema.safeParse({
    id,
    updatedAt: expectedUpdatedAt,
    items,
  });

  if (!authorization || !parsed.success) {
    return {
      status: "error",
      message: parsed.success
        ? "You do not have permission to edit these items."
        : "Please enter valid item details.",
    };
  }

  const supabase = await createClient();
  const [{ data: reservation }, { data: currentItems }, { data: shipments }] =
    await Promise.all([
      supabase
        .from("reservations")
        .select(
          "id, customer_id, status, archived_at, discount, downpayment, notes, updated_at",
        )
        .eq("id", parsed.data.id)
        .maybeSingle(),
      supabase
        .from("reservation_items")
        .select(
          "id, stock_item_id, item_name, sku, category, quantity, unit_price, discount, ordered_at, image_path",
        )
        .eq("reservation_id", parsed.data.id)
        .order("created_at"),
      supabase
        .from("reservation_shipments")
        .select("id, status")
        .eq("reservation_id", parsed.data.id),
    ]);

  if (!reservation || !currentItems) {
    return { status: "error", message: "Unable to load this reservation." };
  }
  if (
    reservation.archived_at ||
    reservation.status !== "reserved"
  ) {
    return {
      status: "error",
      message: "Only active Reserved orders can be edited.",
    };
  }

  const shipmentIds = (shipments ?? [])
    .filter((shipment) => shipment.status === "pending" || shipment.status === "shipped")
    .map((shipment) => shipment.id);
  const { data: shipmentItems } = shipmentIds.length
    ? await supabase
        .from("reservation_shipment_items")
        .select("reservation_item_id, quantity")
        .in("shipment_id", shipmentIds)
    : { data: [] };
  const releasedByItem = new Map<string, number>();
  for (const shipmentItem of shipmentItems ?? []) {
    releasedByItem.set(
      shipmentItem.reservation_item_id,
      (releasedByItem.get(shipmentItem.reservation_item_id) ?? 0) +
        Number(shipmentItem.quantity),
    );
  }

  const incomingById = new Map(
    parsed.data.items
      .filter((item) => Boolean(item.reservationItemId))
      .map((item) => [item.reservationItemId as string, item]),
  );
  const currentById = new Map(currentItems.map((item) => [item.id, item]));
  const rpcItems = [] as Array<{
    reservationItemId?: string;
    stockItemId: string;
    quantity: number;
    sellingPrice: number;
    discount: number;
    orderedAt?: string;
  }>;

  for (const current of currentItems) {
    const releasedQuantity = releasedByItem.get(current.id) ?? 0;
    const incoming = incomingById.get(current.id);
    if (!incoming && releasedQuantity <= 0) continue;

    const source = incoming ?? {
      reservationItemId: current.id,
      stockItemId: current.stock_item_id,
      quantity: 0,
      sellingPrice: Math.round(Number(current.unit_price) * 100),
      discount: Math.round(Number(current.discount ?? 0) * 100),
      orderedAt: current.ordered_at ?? undefined,
    };
    rpcItems.push({
      reservationItemId: current.id,
      stockItemId: source.stockItemId ?? current.stock_item_id,
      quantity: releasedQuantity + source.quantity,
      sellingPrice: source.sellingPrice,
      discount: source.discount,
      orderedAt: source.orderedAt,
    });
  }

  for (const incoming of parsed.data.items) {
    if (incoming.reservationItemId) {
      if (!currentById.has(incoming.reservationItemId)) {
        return { status: "error", message: "An invoice item is no longer available." };
      }
      continue;
    }
    if (!incoming.stockItemId) {
      return { status: "error", message: "An invoice item is no longer available." };
    }
    rpcItems.push({
      reservationItemId: undefined,
      stockItemId: incoming.stockItemId,
      quantity: incoming.quantity,
      sellingPrice: incoming.sellingPrice,
      discount: incoming.discount,
      orderedAt: incoming.orderedAt,
    });
  }

  const { data: reservationId, error } = await supabase.rpc(
    "update_reservation_with_payment_adjustment",
    {
      p_reservation_id: reservation.id,
      p_expected_updated_at: parsed.data.updatedAt,
      p_customer_id: reservation.customer_id,
      p_discount: reservation.discount,
      p_downpayment: reservation.downpayment,
      p_notes: reservation.notes,
      p_items: toRpcItems(rpcItems),
    },
  );

  if (error || !reservationId) {
    const message = error?.message ?? "reservation_update_failed";
    return {
      status: "error",
      message: message.includes("stale_reservation")
        ? "This reservation changed. Refresh the page and try again."
        : mapReservationDatabaseError(message).message,
    };
  }

  revalidateReservationPaths(reservation.id);
  await logActivity(supabase, {
    action: "reservation_edited",
    entityType: "reservation",
    entityId: reservation.id,
    description: "Edited reservation items from the customer invoice.",
    metadata: { customer_id: reservation.customer_id },
  });
  return { status: "success", message: "Invoice items saved." };
}

export async function archiveReservation(id: string): Promise<void> {
  const authorization = await authorizeRoles(["admin"]);
  const parsedId = reservationIdSchema.safeParse(id);

  if (!authorization || !parsedId.success) {
    redirect("/reservations?error=not-authorized");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("archive_reservation", {
    p_reservation_id: parsedId.data,
  });

  if (error) {
    console.error("Reservation archive failed", error.code);
    redirect("/reservations?status=all&archive=active&error=archive-failed");
  }

  await logActivity(supabase, {
    action: "reservation_archived",
    entityType: "reservation",
    entityId: parsedId.data,
    description: "Archived reservation.",
  });
  revalidateReservationPaths(parsedId.data);
  redirect("/reservations?status=all&archive=archived&message=archived");
}

export async function restoreReservation(id: string): Promise<void> {
  const authorization = await authorizeRoles(["admin"]);
  const parsedId = reservationIdSchema.safeParse(id);

  if (!authorization || !parsedId.success) {
    redirect("/reservations?error=not-authorized");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("restore_reservation", {
    p_reservation_id: parsedId.data,
  });

  if (error) {
    console.error("Reservation restore failed", error.code);
    const mapped = mapReservationDatabaseError(error.message);
    const code = mapped.field === "items" ? "restore-stock-failed" : "restore-failed";
    redirect("/reservations?status=all&archive=archived&error=" + code);
  }

  await logActivity(supabase, {
    action: "reservation_restored",
    entityType: "reservation",
    entityId: parsedId.data,
    description: "Restored reservation from archive.",
  });
  revalidateReservationPaths(parsedId.data);
  redirect("/reservations?status=all&archive=active&message=restored");
}

export async function deleteArchivedReservation(id: string): Promise<void> {
  const authorization = await authorizeRoles(["admin"]);
  const parsedId = reservationIdSchema.safeParse(id);

  if (!authorization || !parsedId.success) {
    redirect("/reservations?error=not-authorized");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("delete_archived_reservation", {
    p_reservation_id: parsedId.data,
  });

  if (error) {
    console.error("Delete archived reservation failed", error.code, error.message);
    redirect("/reservations?status=all&archive=archived&error=delete-failed");
  }

  await logActivity(supabase, {
    action: "reservation_deleted",
    entityType: "reservation",
    entityId: parsedId.data,
    description: "Permanently deleted archived reservation.",
  });
  revalidatePath("/reservations");
  redirect("/reservations?status=all&archive=archived&message=deleted");
}

export async function deleteAllArchivedReservations(): Promise<void> {
  const authorization = await authorizeRoles(["admin"]);

  if (!authorization) {
    redirect("/reservations?error=not-authorized");
  }

  const supabase = await createClient();
  const { data: count, error } = await supabase.rpc("delete_all_archived_reservations");

  if (error) {
    console.error("Delete all archived reservations failed", error.code, error.message);
    redirect("/reservations?status=all&archive=archived&error=delete-failed");
  }

  await logActivity(supabase, {
    action: "archived_reservations_purged",
    entityType: "reservation",
    description: `Permanently deleted all (${count ?? 0}) archived reservation(s).`,
    metadata: { count },
  });
  revalidatePath("/reservations");
  redirect("/reservations?status=all&archive=archived&message=all-deleted");
}

function getSelectedReservationIds(formData: FormData): string[] | null {
  const ids = formData
    .getAll("reservationIds")
    .filter((value): value is string => typeof value === "string");
  const parsed = ids.map((id) => reservationIdSchema.safeParse(id));
  if (
    !ids.length ||
    ids.length > 100 ||
    new Set(ids).size !== ids.length ||
    parsed.some((result) => !result.success)
  ) {
    return null;
  }
  return ids;
}

const BULK_RETURN_STATUSES = [
  "reserved",
  "partially-paid",
  "paid",
  "delivered",
  "cancelled",
  "all",
];

// Same two-stage rule as the single-record actions: active orders move to
// Archived, where they can be restored; only archived orders can be deleted
// permanently (the database function enforces this too).
async function bulkRemoveReservations(
  formData: FormData,
  ids: string[] | null,
  mode: "archive" | "delete",
): Promise<never> {
  const authorization = await authorizeRoles(["admin"]);
  if (!authorization || !ids) {
    redirect("/reservations?error=invalid-bulk-selection");
  }

  const requestedStatus = getTextField(formData, "returnStatus") ?? "";
  const status = BULK_RETURN_STATUSES.includes(requestedStatus)
    ? requestedStatus
    : "reserved";
  const listUrl =
    "/reservations?status=" +
    status +
    "&archive=" +
    (mode === "archive" ? "active" : "archived");

  const supabase = await createClient();
  let completed = 0;
  let failed = false;
  for (const id of ids) {
    const { error } =
      mode === "archive"
        ? await supabase.rpc("archive_reservation", { p_reservation_id: id })
        : await supabase.rpc("delete_archived_reservation", {
            p_reservation_id: id,
          });
    if (error) {
      console.error("Bulk reservation removal failed", mode, error.code);
      failed = true;
      break;
    }
    completed += 1;
  }

  if (completed > 0) {
    await logActivity(supabase, {
      action:
        mode === "archive" ? "reservation_archived" : "reservation_deleted",
      entityType: "reservation",
      description:
        (mode === "archive" ? "Archived " : "Permanently deleted ") +
        completed +
        " selected reservation(s).",
      metadata: { count: completed, ids: ids.slice(0, completed) },
    });
  }
  revalidatePath("/reservations");

  if (failed) {
    redirect(
      listUrl +
        "&error=" +
        (mode === "archive" ? "archive-failed" : "delete-failed"),
    );
  }
  redirect(
    listUrl + "&message=" + (mode === "archive" ? "bulk-archived" : "bulk-deleted"),
  );
}

export async function bulkTransitionReservations(
  formData: FormData,
): Promise<void> {
  const operation = getTextField(formData, "operation");
  const ids = getSelectedReservationIds(formData);
  if (operation === "archive" || operation === "delete") {
    await bulkRemoveReservations(formData, ids, operation);
  }
  const requiredRoles =
    operation === "cancel" ? (["admin"] as const) : (["admin", "staff"] as const);
  const authorization = await authorizeRoles(requiredRoles);
  const newStatus =
    operation === "cancel"
      ? "cancelled"
      : operation === "deliver"
        ? "delivered"
        : null;

  if (!authorization || !ids || !newStatus) {
    redirect("/reservations?error=invalid-bulk-selection");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("bulk_transition_reservations", {
    p_reservation_ids: ids,
    p_new_status: newStatus,
  });
  if (error) {
    console.error("Bulk reservation transition failed", error.code);
    redirect("/reservations?error=bulk-transition-failed");
  }

  revalidatePath("/reservations");
  ids.forEach((id) => {
    revalidatePath("/reservations/" + id);
    revalidatePath("/reservations/" + id + "/invoice");
  });
  await logActivity(supabase, {
    action: "reservations_bulk_transition",
    entityType: "reservation",
    description:
      "Bulk changed " + ids.length + " reservation(s) to " + newStatus + ".",
    metadata: { new_status: newStatus, count: ids.length, ids },
  });
  redirect(
    "/reservations?status=" +
      newStatus +
      "&message=" +
      encodeURIComponent(ids.length + " reservation(s) updated."),
  );
}

export async function bulkRevertPaidReservations(
  formData: FormData,
): Promise<void> {
  const authorization = await authorizeRoles(["admin"]);
  const rawIds = getTextField(formData, "reservationIds");
  let ids: string[] | null = null;
  try {
    const values = rawIds ? (JSON.parse(rawIds) as unknown) : null;
    if (
      Array.isArray(values) &&
      values.length > 0 &&
      values.length <= 50 &&
      new Set(values).size === values.length &&
      values.every((value) => reservationIdSchema.safeParse(value).success)
    ) {
      ids = values as string[];
    }
  } catch {
    ids = null;
  }
  const reason = getTextField(formData, "reason")?.trim();

  if (!authorization || !ids || !reason || reason.length < 3 || reason.length > 1000) {
    redirect("/reservations?status=paid&error=invalid-revert");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("bulk_revert_paid_reservations", {
    p_reservation_ids: ids,
    p_reason: reason,
  });
  if (error) {
    console.error("Paid reservation reversion failed", error.code);
    redirect("/reservations?status=paid&error=revert-failed");
  }

  revalidatePath("/reservations");
  ids.forEach((id) => revalidatePath("/reservations/" + id));
  await logActivity(supabase, {
    action: "paid_reservations_bulk_reverted",
    entityType: "reservation",
    description:
      "Reverted " + ids.length + " Paid reservation(s) to Reserved.",
    metadata: { count: ids.length, ids, reason },
  });
  redirect(
    "/reservations?status=reserved&message=" +
      encodeURIComponent(ids.length + " reservation(s) reverted to Reserved."),
  );
}
