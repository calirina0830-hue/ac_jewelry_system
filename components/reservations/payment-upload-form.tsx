"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { recordReservationPayments } from "@/actions/payments";
import {
  MAX_PAYMENT_EVIDENCE_ATTACHMENTS,
  PAYMENT_EVIDENCE_BUCKET,
} from "@/lib/constants/payments";
import {
  buildPaymentEvidencePath,
  getPaymentEvidenceMetadataFieldName,
  sanitizePaymentEvidenceFileName,
  validatePaymentEvidence,
  type PaymentEvidenceMetadata,
} from "@/lib/storage/payment-evidence";
import { createClient } from "@/lib/supabase/client";

type PaymentSubmissionPhase = "idle" | "uploading" | "recording";

const PaymentSubmissionContext = createContext<PaymentSubmissionPhase>("idle");

export function usePaymentSubmissionPhase(): PaymentSubmissionPhase {
  return useContext(PaymentSubmissionContext);
}

class PaymentUploadError extends Error {}

async function removeAttemptUploads(
  supabase: ReturnType<typeof createClient>,
  paths: readonly string[],
) {
  if (!paths.length) return;
  const { error } = await supabase.storage
    .from(PAYMENT_EVIDENCE_BUCKET)
    .remove([...paths]);
  if (error) console.error("Payment evidence cleanup failed.");
}

function getSelectedFiles(formData: FormData, reservationId: string): File[] {
  return formData
    .getAll("evidence:" + reservationId)
    .filter((value): value is File => value instanceof File && value.size > 0);
}

export function PaymentUploadForm({
  children,
  reservationIds,
}: {
  children: ReactNode;
  reservationIds: string[];
}) {
  const router = useRouter();
  const submittingRef = useRef(false);
  const [phase, setPhase] = useState<PaymentSubmissionPhase>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;

    submittingRef.current = true;
    setErrorMessage("");

    const form = event.currentTarget;
    const formData = new FormData(form);
    const filesByReservation = new Map(
      reservationIds.map((reservationId) => [
        reservationId,
        getSelectedFiles(formData, reservationId),
      ]),
    );
    const selectedFileCount = [...filesByReservation.values()].reduce(
      (total, files) => total + files.length,
      0,
    );
    const supabase = createClient();
    const uploadedPaths: string[] = [];

    try {
      let userId: string | null = null;
      if (selectedFileCount > 0) {
        setPhase("uploading");
        const {
          data: { user },
          error,
        } = await supabase.auth.getUser();
        if (error || !user) {
          throw new PaymentUploadError(
            "Your session could not be verified. Sign in and try again.",
          );
        }
        userId = user.id;
      }

      for (const reservationId of reservationIds) {
        const files = filesByReservation.get(reservationId) ?? [];
        const fieldName = "evidence:" + reservationId;
        formData.delete(fieldName);

        if (files.length > MAX_PAYMENT_EVIDENCE_ATTACHMENTS) {
          throw new PaymentUploadError(
            "Select no more than 5 evidence images per payment.",
          );
        }

        const evidence: PaymentEvidenceMetadata[] = [];
        for (const file of files) {
          const validation = await validatePaymentEvidence(file);
          if (!validation.success) {
            throw new PaymentUploadError(validation.message);
          }
          if (!userId) {
            throw new PaymentUploadError(
              "Your session could not be verified. Sign in and try again.",
            );
          }

          const path = buildPaymentEvidencePath(
            userId,
            reservationId,
            crypto.randomUUID(),
            validation.evidence.extension,
          );
          const { error } = await supabase.storage
            .from(PAYMENT_EVIDENCE_BUCKET)
            .upload(path, validation.evidence.body, {
              cacheControl: "31536000",
              contentType: validation.evidence.contentType,
              upsert: false,
            });
          if (error) {
            console.error("Payment evidence upload failed.");
            throw new PaymentUploadError(
              "An evidence image could not be uploaded. No payment was recorded. Try again.",
            );
          }

          uploadedPaths.push(path);
          evidence.push({
            storage_path: path,
            original_file_name: sanitizePaymentEvidenceFileName(
              file.name,
              validation.evidence.extension,
            ),
            mime_type: validation.evidence.contentType,
            file_size: file.size,
          });
        }

        formData.set(
          getPaymentEvidenceMetadataFieldName(reservationId),
          JSON.stringify(evidence),
        );
      }

      const remainingFileFields = new Set(
        [...formData.entries()].flatMap(([name, value]) =>
          value instanceof File ? [name] : [],
        ),
      );
      remainingFileFields.forEach((name) => formData.delete(name));
    } catch (error) {
      await removeAttemptUploads(supabase, uploadedPaths);
      setErrorMessage(
        error instanceof PaymentUploadError
          ? error.message
          : "Payment evidence could not be uploaded. Try again.",
      );
      setPhase("idle");
      submittingRef.current = false;
      return;
    }

    setPhase("recording");
    try {
      const result = await recordReservationPayments(formData);
      if (result.status === "error") {
        await removeAttemptUploads(supabase, uploadedPaths);
      } else {
        form.reset();
      }
      router.push(result.redirectTo);
      router.refresh();
    } catch {
      console.error("Payment recording request failed.");
      setErrorMessage(
        "The payment could not be recorded. Please check your connection before trying again.",
      );
      setPhase("idle");
      submittingRef.current = false;
    }
  }

  return (
    <PaymentSubmissionContext.Provider value={phase}>
      <form className="mt-7 space-y-5" onSubmit={handleSubmit}>
        {errorMessage && (
          <div
            className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-800"
            role="alert"
          >
            {errorMessage}
          </div>
        )}
        <span aria-live="polite" className="sr-only">
          {phase === "uploading"
            ? "Uploading evidence..."
            : phase === "recording"
              ? "Recording payment..."
              : ""}
        </span>
        {children}
      </form>
    </PaymentSubmissionContext.Provider>
  );
}
