"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ZodError } from "zod";

import { logActivity } from "@/lib/activity";
import { authorizeRoles } from "@/lib/auth";
import { mapReservationDatabaseError } from "@/lib/reservations/errors";
import { centsToDecimal } from "@/lib/reservations/money";
import { canRoleTransitionReservation } from "@/lib/reservations/status";
import { createClient } from "@/lib/supabase/server";
import {
  createReservationSchema,
  reservationInvoiceNotesSchema,
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
  revalidatePath("/dashboard");
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
  const { data: reservationId, error } = await supabase.rpc(
    "create_reservation",
    {
      p_customer_id: parsed.data.customerId,
      p_discount: centsToDecimal(parsed.data.reservationDiscount),
      p_downpayment: centsToDecimal(parsed.data.downpayment),
      p_notes: parsed.data.notes,
      p_items: toRpcItems(parsed.data.items),
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
  redirect("/reservations/" + reservationId + "?message=created");
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
  const { data: reservationId, error } = await supabase.rpc(
    "update_reservation",
    {
      p_reservation_id: parsed.data.id,
      p_expected_updated_at: parsed.data.updatedAt,
      p_customer_id: parsed.data.customerId,
      p_discount: centsToDecimal(parsed.data.reservationDiscount),
      p_downpayment: centsToDecimal(parsed.data.downpayment),
      p_notes: parsed.data.notes,
      p_items: toRpcItems(parsed.data.items),
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
  redirect("/reservations/" + reservationId + "?message=updated");
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
    redirect("/reservations/" + id + "?error=not-authorized");
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
    redirect("/reservations/" + parsed.data.id + "?error=invalid-transition");
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
      "/reservations/" +
        parsed.data.id +
        "?error=" +
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
    "/reservations/" +
      parsed.data.id +
      "?message=status-" +
      parsed.data.newStatus,
  );
}

export type InvoiceMutationResult = {
  status: "success" | "error";
  message: string;
};

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

export async function bulkTransitionReservations(
  formData: FormData,
): Promise<void> {
  const operation = getTextField(formData, "operation");
  const ids = getSelectedReservationIds(formData);
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
  revalidatePath("/dashboard");
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
  revalidatePath("/dashboard");
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
