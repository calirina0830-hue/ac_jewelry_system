"use server";

import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import { authorizeRoles } from "@/lib/auth";
import { PAYMENT_EVIDENCE_BUCKET } from "@/lib/constants/payments";
import { centsToDecimal } from "@/lib/reservations/money";
import {
  getPaymentEvidenceMetadataFieldName,
  isExpectedPaymentEvidenceUploadPath,
  validatePaymentEvidence,
  type PaymentEvidenceMetadata,
} from "@/lib/storage/payment-evidence";
import { createClient } from "@/lib/supabase/server";
import {
  paymentBatchIdsSchema,
  paymentEvidenceListSchema,
  paymentEntrySchema,
} from "@/lib/validation/payments";

export type RecordPaymentsResult = {
  status: "success" | "error";
  redirectTo: string;
};

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
  console.error(label, {
    code: getErrorField(error, "code") ?? getErrorField(error, "errorCode"),
    status:
      getErrorField(error, "status") ?? getErrorField(error, "statusCode"),
    message:
      getErrorField(error, "message") ??
      (typeof error === "string" ? error : undefined),
  });
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

function paymentUrl(ids: string[], error?: string): string {
  const query = new URLSearchParams({ ids: ids.join(",") });
  if (error) query.set("error", error);
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
    return { status: "error", redirectTo: paymentUrl(ids, "invalid-evidence") };
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
    return { status: "error", redirectTo: paymentUrl(ids, "invalid-payment") };
  }

  const supabase = await createClient();
  const rpcEntries: Array<Record<string, unknown>> = [];

  if (!(await verifyEvidenceObjects(supabase, evidenceSubmission.byReservation))) {
    await cleanupEvidence(supabase, evidenceSubmission.paths);
    return { status: "error", redirectTo: paymentUrl(ids, "invalid-evidence") };
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
    return { status: "error", redirectTo: paymentUrl(ids, "payment-failed") };
  }
  if (rpcError) {
    logPaymentError("Bulk payment recording failed", rpcError);
    await cleanupEvidence(supabase, evidenceSubmission.paths);
    const message = String(getErrorField(rpcError, "message") ?? "");
    const code = message.includes("pricing_incomplete")
      ? "pricing-incomplete"
      : message.includes("deduction_exceeds_paid")
        ? "deduction-exceeds-paid"
        : message.includes("payment_exceeds_balance")
          ? "overpayment"
          : message.includes("stale_reservation")
            ? "stale-reservation"
            : "payment-failed";
    return { status: "error", redirectTo: paymentUrl(ids, code) };
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
      ids.length === 1
        ? "/reservations/" + ids[0] + "?message=" + encodeURIComponent(
            wasFullySettled
              ? "Final payment recorded. Reservation is now Paid."
              : "Payment recorded.",
          )
        : "/reservations?message=" +
          encodeURIComponent(ids.length + " payment(s) recorded."),
  };
}
