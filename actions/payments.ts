"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { logActivity } from "@/lib/activity";
import { authorizeRoles } from "@/lib/auth";
import { PAYMENT_EVIDENCE_BUCKET } from "@/lib/constants/payments";
import { centsToDecimal } from "@/lib/reservations/money";
import { loadPaymentTransactionSummaries } from "@/lib/reservations/payment-transaction-data";
import {
  getPaymentEvidenceMetadataFieldName,
  isExpectedPaymentEvidenceUploadPath,
  validatePaymentEvidence,
  type PaymentEvidenceMetadata,
} from "@/lib/storage/payment-evidence";
import { createClient } from "@/lib/supabase/server";
import {
  editPaymentSchema,
  voidPaymentSchema,
  paymentBatchIdsSchema,
  paymentEvidenceListSchema,
  paymentEntrySchema,
} from "@/lib/validation/payments";

export type RecordPaymentsResult = {
  status: "success" | "error";
  redirectTo: string;
};

export type EditReservationPaymentResult =
  | { status: "success"; redirectTo: string }
  | { status: "error"; error: string; diagnostic?: string };

type ParsedEvidence = {
  byReservation: Map<string, PaymentEvidenceMetadata[]>;
  paths: string[];
};

function getErrorField(error: unknown, field: string): string | number | undefined {
  if (typeof error !== "object" || error === null || !(field in error)) {
    return undefined;
  }

  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}

function logPaymentError(label: string, error: unknown) {
  const code = getErrorField(error, "code") ?? getErrorField(error, "errorCode");
  const status =
    getErrorField(error, "status") ?? getErrorField(error, "statusCode");
  const message =
    getErrorField(error, "message") ??
    (typeof error === "string" ? error : String(error));
  console.error(label, "code=" + String(code ?? "unknown"), "status=" + String(status ?? "unknown"), "message=" + message);
}

function parseIds(formData: FormData): string[] | null {
  const raw = formData.get("reservationIds");
  if (typeof raw !== "string") return null;
  try {
    const parsed = paymentBatchIdsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function paymentUrl(ids: string[], error?: string, mode?: string): string {
  const query = new URLSearchParams({ ids: ids.join(",") });
  if (error) query.set("error", error);
  if (mode) query.set("mode", mode);
  return "/reservations/bulk/pay?" + query.toString();
}

function parseSubmittedEvidence(
  formData: FormData,
  ids: string[],
  userId: string,
): ParsedEvidence | null {
  if ([...formData.values()].some((value) => value instanceof File)) {
    return null;
  }

  const byReservation = new Map<string, PaymentEvidenceMetadata[]>();
  const paths: string[] = [];
  const uniquePaths = new Set<string>();

  for (const reservationId of ids) {
    const values = formData.getAll(
      getPaymentEvidenceMetadataFieldName(reservationId),
    );
    if (
      values.length > 1 ||
      (values.length === 1 && typeof values[0] !== "string")
    ) {
      return null;
    }

    let rawEvidence: unknown = [];
    if (typeof values[0] === "string") {
      try {
        rawEvidence = JSON.parse(values[0]);
      } catch {
        return null;
      }
    }

    const parsed = paymentEvidenceListSchema.safeParse(rawEvidence);
    if (!parsed.success) return null;

    for (const evidence of parsed.data) {
      if (
        uniquePaths.has(evidence.storage_path) ||
        !isExpectedPaymentEvidenceUploadPath(
          evidence.storage_path,
          userId,
          reservationId,
          evidence.mime_type,
        )
      ) {
        return null;
      }
      uniquePaths.add(evidence.storage_path);
      paths.push(evidence.storage_path);
    }
    byReservation.set(reservationId, parsed.data);
  }

  return { byReservation, paths };
}

async function cleanupEvidence(
  supabase: Awaited<ReturnType<typeof createClient>>,
  paths: readonly string[],
) {
  const candidates = [...new Set(paths)];
  if (!candidates.length) return;

  try {
    const [evidenceReferences, legacyReferences] = await Promise.all([
      supabase
        .from("reservation_payment_evidence")
        .select("storage_path")
        .in("storage_path", candidates),
      supabase
        .from("reservation_payments")
        .select("evidence_path")
        .in("evidence_path", candidates),
    ]);
    if (evidenceReferences.error || legacyReferences.error) {
      logPaymentError(
        "Payment evidence cleanup reference check failed",
        evidenceReferences.error ?? legacyReferences.error,
      );
      return;
    }

    const referenced = new Set<string>([
      ...(evidenceReferences.data ?? []).map((item) => item.storage_path),
      ...(legacyReferences.data ?? []).flatMap((item) =>
        item.evidence_path ? [item.evidence_path] : [],
      ),
    ]);
    const removable = candidates.filter((path) => !referenced.has(path));
    if (!removable.length) return;

    const { error } = await supabase.storage
      .from(PAYMENT_EVIDENCE_BUCKET)
      .remove(removable);
    if (error) logPaymentError("Payment evidence cleanup failed", error);
  } catch (error) {
    logPaymentError("Payment evidence cleanup threw", error);
  }
}

async function verifyEvidenceObjects(
  supabase: Awaited<ReturnType<typeof createClient>>,
  evidenceByReservation: Map<string, PaymentEvidenceMetadata[]>,
): Promise<boolean> {
  try {
    for (const evidence of evidenceByReservation.values()) {
      for (const attachment of evidence) {
        const { data, error } = await supabase.storage
          .from(PAYMENT_EVIDENCE_BUCKET)
          .download(attachment.storage_path);
        if (error || !data) {
          logPaymentError("Payment evidence verification download failed", error);
          return false;
        }

        const validation = await validatePaymentEvidence(data);
        if (
          !validation.success ||
          data.size !== attachment.file_size ||
          validation.evidence.contentType !== attachment.mime_type
        ) {
          console.error("Payment evidence verification failed.");
          return false;
        }
      }
    }
  } catch (error) {
    logPaymentError("Payment evidence verification threw", error);
    return false;
  }
  return true;
}

export async function recordReservationPayments(
  formData: FormData,
): Promise<RecordPaymentsResult> {
  const authorization = await authorizeRoles(["admin", "staff"]);
  const ids = parseIds(formData);
  const isSettlement = formData.get("paymentMode") === "settle";
  const paymentMode = isSettlement ? "settle" : undefined;
  if (!authorization || !ids) {
    return {
      status: "error",
      redirectTo: "/reservations?status=reserved&error=not-authorized",
    };
  }

  const evidenceSubmission = parseSubmittedEvidence(
    formData,
    ids,
    authorization.user.id,
  );
  if (!evidenceSubmission) {
    return { status: "error", redirectTo: paymentUrl(ids, "invalid-evidence", paymentMode) };
  }

  const entries = ids.map((id) =>
    paymentEntrySchema.safeParse({
      reservationId: id,
      expectedUpdatedAt: formData.get("updatedAt:" + id),
      amount: formData.get("amount:" + id),
      paymentMethod: formData.get("paymentMethod:" + id) ?? "",
      referenceNo: formData.get("referenceNo:" + id) ?? "",
      notes: formData.get("notes:" + id) ?? "",
    }),
  );
  if (entries.some((entry) => !entry.success)) {
    const supabase = await createClient();
    await cleanupEvidence(supabase, evidenceSubmission.paths);
    return { status: "error", redirectTo: paymentUrl(ids, "invalid-payment", paymentMode) };
  }

  const supabase = await createClient();
  const rpcEntries: Array<Record<string, unknown>> = [];

  const { data: currentReservations, error: reservationError } = await supabase
    .from("reservations")
    .select("id, total, discount, balance, status, delivered_at")
    .in("id", ids);
  if (
    reservationError ||
    !currentReservations ||
    currentReservations.length !== ids.length
  ) {
    await cleanupEvidence(supabase, evidenceSubmission.paths);
    return { status: "error", redirectTo: paymentUrl(ids, "payment-failed", paymentMode) };
  }

  if (
    isSettlement &&
    currentReservations.some(
      (reservation) =>
        reservation.status !== "reserved" ||
        !reservation.delivered_at ||
        Number(reservation.balance) <= 0,
    )
  ) {
    await cleanupEvidence(supabase, evidenceSubmission.paths);
    return { status: "error", redirectTo: paymentUrl(ids, "payment-failed", paymentMode) };
  }

  let transactionSummaries;
  try {
    transactionSummaries = await loadPaymentTransactionSummaries(
      supabase,
      currentReservations,
    );
  } catch (error) {
    logPaymentError("Payment transaction summary failed", error);
    await cleanupEvidence(supabase, evidenceSubmission.paths);
    return { status: "error", redirectTo: paymentUrl(ids, "payment-failed", paymentMode) };
  }

  for (const entry of entries) {
    if (!entry.success || entry.data.amount < 0) continue;
    const currentReservation = currentReservations.find(
      (reservation) => reservation.id === entry.data.reservationId,
    );
    const remainingBalance = isSettlement
      ? Number(currentReservation?.balance ?? 0)
      : transactionSummaries.get(entry.data.reservationId)?.remainingBalance;
    if (
      remainingBalance === undefined ||
      entry.data.amount > Math.round(remainingBalance * 100)
    ) {
      await cleanupEvidence(supabase, evidenceSubmission.paths);
      return { status: "error", redirectTo: paymentUrl(ids, "overpayment", paymentMode) };
    }
  }

  if (!(await verifyEvidenceObjects(supabase, evidenceSubmission.byReservation))) {
    await cleanupEvidence(supabase, evidenceSubmission.paths);
    return { status: "error", redirectTo: paymentUrl(ids, "invalid-evidence", paymentMode) };
  }

  for (const parsed of entries) {
    if (!parsed.success) continue;
    rpcEntries.push({
      reservation_id: parsed.data.reservationId,
      expected_updated_at: parsed.data.expectedUpdatedAt,
      amount: centsToDecimal(parsed.data.amount),
      payment_method: parsed.data.paymentMethod,
      reference_no: parsed.data.referenceNo,
      notes: parsed.data.notes,
      evidence:
        evidenceSubmission.byReservation.get(parsed.data.reservationId) ?? [],
    });
  }

  let rpcError: unknown;
  let wasFullySettled = false;
  try {
    const result = await supabase.rpc("bulk_record_reservation_payments", {
      p_payments: rpcEntries,
    });
    rpcError = result.error;
    const firstResult = result.data?.results?.[0];
    wasFullySettled =
      typeof firstResult === "object" &&
      firstResult !== null &&
      "fullySettled" in firstResult &&
      firstResult.fullySettled === true;
  } catch (error) {
    logPaymentError("Bulk payment recording threw", error);
    await cleanupEvidence(supabase, evidenceSubmission.paths);
    return { status: "error", redirectTo: paymentUrl(ids, "payment-failed", paymentMode) };
  }
  if (rpcError) {
    logPaymentError("Bulk payment recording failed", rpcError);
    await cleanupEvidence(supabase, evidenceSubmission.paths);
    const message = String(getErrorField(rpcError, "message") ?? "");
    const code = message.includes("pricing_incomplete")
      ? "pricing-incomplete"
      : message.includes("deduction_exceeds_paid")
        ? "deduction-exceeds-paid"
        : message.includes("payment_exceeds_balance") ||
            message.includes("payment_exceeds_items_total")
          ? "overpayment"
          : message.includes("stale_reservation")
            ? "stale-reservation"
            : "payment-failed";
    return { status: "error", redirectTo: paymentUrl(ids, code, paymentMode) };
  }

  revalidatePath("/reservations");
  revalidatePath("/dashboard");
  for (const id of ids) {
    revalidatePath("/reservations/" + id);
    revalidatePath("/reservations/" + id + "/invoice");
  }
  await Promise.all(
    ids.map((id) =>
      logActivity(supabase, {
        action: "payment_recorded",
        entityType: "reservation",
        entityId: id,
        description: "Recorded a payment against a reservation.",
        metadata: { fully_settled: wasFullySettled },
      }),
    ),
  );
  return {
    status: "success",
    redirectTo:
      isSettlement
        ? "/reservations?status=settled&message=settled"
        : ids.length === 1
        ? "/reservations/" + ids[0] + "?message=" + encodeURIComponent(
            wasFullySettled
              ? "Final payment recorded. Reservation is now Paid."
              : "Payment recorded.",
          )
        : "/reservations?message=" +
          encodeURIComponent(ids.length + " payment(s) recorded."),
  };
}

export async function editReservationPayment(
  formData: FormData,
): Promise<EditReservationPaymentResult> {
  const authorization = await authorizeRoles(["admin", "staff"]);
  if (!authorization) return { status: "error", error: "not-authorized" };

  const parsed = editPaymentSchema.safeParse({
    paymentId: formData.get("paymentId"),
    reservationId: formData.get("reservationId"),
    expectedUpdatedAt: formData.get("expectedUpdatedAt"),
    expectedPaymentRecordedAt: formData.get("expectedPaymentRecordedAt"),
    amount: formData.get("amount"),
    paymentMethod: formData.get("paymentMethod") ?? "",
    referenceNo: formData.get("referenceNo") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) return { status: "error", error: "invalid-payment" };

  const supabase = await createClient();
  const runEdit = (expectedReservationUpdatedAt: string) =>
    supabase.rpc("edit_reservation_payment", {
      p_payment_id: parsed.data.paymentId,
      p_expected_payment_recorded_at: parsed.data.expectedPaymentRecordedAt,
      p_expected_reservation_updated_at: expectedReservationUpdatedAt,
      p_amount: centsToDecimal(parsed.data.amount),
      p_payment_method: parsed.data.paymentMethod,
      p_reference_no: parsed.data.referenceNo,
      p_notes: parsed.data.notes,
    });
  let result: Awaited<ReturnType<typeof runEdit>>;
  try {
    result = await runEdit(parsed.data.expectedUpdatedAt);

    // Other legitimate work on the reservation (for example another payment
    // or a release) changes reservations.updated_at. If this exact payment is
    // still active and unchanged, retry using the current reservation version;
    // the RPC still locks the row and checks the payment's own recorded_at.
    if (
      result.error &&
      String(getErrorField(result.error, "message") ?? "").includes(
        "stale_reservation",
      )
    ) {
      const { data: currentPayment, error: paymentLookupError } = await supabase
        .from("reservation_payments")
        .select("reservation_id, recorded_at, voided_at")
        .eq("id", parsed.data.paymentId)
        .maybeSingle();
      if (
        !paymentLookupError &&
        currentPayment &&
        !currentPayment.voided_at &&
        currentPayment.recorded_at === parsed.data.expectedPaymentRecordedAt
      ) {
        const { data: currentReservation, error: reservationLookupError } =
          await supabase
            .from("reservations")
            .select("updated_at")
            .eq("id", currentPayment.reservation_id)
            .maybeSingle();
        if (!reservationLookupError && currentReservation) {
          result = await runEdit(currentReservation.updated_at);
        }
      }
    }
  } catch (error) {
    logPaymentError("Payment edit threw", error);
    return { status: "error", error: "payment-edit-failed" };
  }

  if (result.error) {
    logPaymentError("Payment edit failed", result.error);
    const message = result.error.message ?? "";
    const code = result.error.code ?? "";
    const error = message.includes("stale_reservation")
      ? "stale-reservation"
      : message.includes("stale_payment")
        ? "stale-payment"
        : message.includes("payment_exceeds_balance") ||
            message.includes("payment_exceeds_items_total")
          ? "overpayment"
          : message.includes("deduction_exceeds_paid")
            ? "deduction-exceeds-paid"
            : message.includes("downpayment_below_committed")
              ? "downpayment-committed"
              : message.includes("reservation_not_editable") ||
                  message.includes("payment_not_editable")
                ? "payment-not-editable"
                : message.includes("pricing_incomplete")
                  ? "pricing-incomplete"
                  : message.includes("invalid_payment")
                    ? "invalid-payment"
                    : code === "23514" &&
                        /reservations_balance_consistent/i.test(message)
                      ? "payment-edit-migration-required"
                      : code === "22P02" && /profile_role/i.test(message)
                        ? "payment-edit-migration-required"
                      : code === "23514"
                        ? "invalid-payment"
                    : message.includes("not_authorized") || code === "42501"
                      ? "not-authorized"
                      : code === "PGRST202" ||
                          /could not find the function|schema cache/i.test(message)
                        ? "payment-edit-migration-required"
                        : "payment-edit-failed";
    return {
      status: "error",
      error,
      diagnostic: error === "payment-edit-failed" ? code || "UNKNOWN" : undefined,
    };
  }

  const reservationId = getErrorField(result.data, "reservationId");
  if (typeof reservationId !== "string") {
    return { status: "error", error: "payment-edit-failed" };
  }

  revalidatePath("/reservations");
  revalidatePath("/dashboard");
  revalidatePath("/reservations/" + reservationId);
  revalidatePath("/reservations/" + reservationId + "/invoice");
  await logActivity(supabase, {
    action: "payment_edited",
    entityType: "reservation",
    entityId: reservationId,
    description: "Corrected a reservation payment record.",
    metadata: {
      replaced_payment_id: parsed.data.paymentId,
      replacement_payment_id: getErrorField(result.data, "paymentId") ?? null,
    },
  });

  return {
    status: "success",
    redirectTo:
      "/reservations/" +
      reservationId +
      "?message=payment-edited",
  };
}

export async function voidReservationPayment(formData: FormData): Promise<void> {
  const authorization = await authorizeRoles(["admin", "staff"]);
  const parsed = voidPaymentSchema.safeParse({
    paymentId: formData.get("paymentId"),
    reservationId: formData.get("reservationId"),
    expectedPaymentRecordedAt: formData.get("expectedPaymentRecordedAt"),
    expectedUpdatedAt: formData.get("expectedUpdatedAt"),
    remarks: formData.get("remarks"),
  });

  if (!authorization || !parsed.success) {
    redirect("/reservations?error=not-authorized");
  }

  const supabase = await createClient();
  let result: Awaited<ReturnType<typeof supabase.rpc<"delete_reservation_payment">>>;
  try {
    result = await supabase.rpc("delete_reservation_payment", {
      p_payment_id: parsed.data.paymentId,
      p_expected_payment_recorded_at: parsed.data.expectedPaymentRecordedAt,
      p_expected_reservation_updated_at: parsed.data.expectedUpdatedAt,
      p_void_reason: parsed.data.remarks,
    });
  } catch (error) {
    logPaymentError("Payment void threw", error);
    redirect(
      "/reservations/" + parsed.data.reservationId + "?error=payment-void-failed",
    );
  }

  if (result.error) {
    logPaymentError("Payment void failed", result.error);
    const message = String(getErrorField(result.error, "message") ?? "");
    const code = String(getErrorField(result.error, "code") ?? "");
    const error = message.includes("stale_reservation")
      ? "stale-reservation"
      : message.includes("stale_payment")
        ? "stale-payment"
        : message.includes("deduction_exceeds_paid")
          ? "payment-void-deduction-exceeds-paid"
          : message.includes("downpayment_below_committed")
            ? "payment-void-downpayment-committed"
            : message.includes("payment_delete_exceeds_total")
              ? "payment-void-exceeds-total"
              : message.includes("invalid_void_reason")
                ? "payment-void-invalid"
                : message.includes("payment_not_editable") ||
                    message.includes("reservation_not_editable")
                  ? "payment-not-editable"
                  : message.includes("payment_not_found") ||
                      message.includes("reservation_not_found")
                    ? "stale-payment"
                    : message.includes("not_authorized") || code === "42501"
                      ? "not-authorized"
                      : code === "PGRST202" ||
                          /could not find the function|schema cache/i.test(message)
                        ? "payment-void-migration-required"
                        : "payment-void-failed";
    redirect("/reservations/" + parsed.data.reservationId + "?error=" + error);
  }

  const actualReservationId = getErrorField(result.data, "reservationId");
  const targetReservationId =
    typeof actualReservationId === "string"
      ? actualReservationId
      : parsed.data.reservationId;

  revalidatePath("/reservations");
  revalidatePath("/dashboard");
  revalidatePath("/reservations/" + targetReservationId);
  revalidatePath("/reservations/" + targetReservationId + "/invoice");
  await logActivity(supabase, {
    action: "payment_voided",
    entityType: "reservation",
    entityId: targetReservationId,
    description: "Voided a payment from the active reservation totals.",
    metadata: {
      payment_id: parsed.data.paymentId,
      remarks: parsed.data.remarks,
    },
  });

  redirect("/reservations/" + targetReservationId + "?message=payment-voided");
}
