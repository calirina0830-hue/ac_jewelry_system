"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { editReservationPayment } from "@/actions/payments";

const EDIT_ERRORS: Record<string, string> = {
  "not-authorized": "You do not have permission to edit payment records.",
  "invalid-payment": "Check the payment details and try again.",
  "stale-reservation": "The reservation or payment changed while saving. Reload and try again.",
  "stale-payment": "This payment was changed in another session. Reload before trying again.",
  overpayment: "The corrected payments cannot exceed the reservation total.",
  "deduction-exceeds-paid": "The corrected amount cannot reduce payments below zero.",
  "downpayment-committed": "The corrected amount is below the downpayment already committed to releases.",
  "payment-not-editable": "This payment or reservation can no longer be edited.",
  "pricing-incomplete": "Complete reservation pricing before editing its payment.",
  "payment-edit-migration-required":
    "Payment editing is not available yet. Apply the latest database migrations, then try again.",
  "payment-edit-failed": "The payment could not be edited. Please try again.",
};

export function EditPaymentRecord({
  paymentId,
  reservationId,
  reservationUpdatedAt,
  paymentRecordedAt,
  amount,
  paymentMethod,
  referenceNo,
  notes,
}: {
  paymentId: string;
  reservationId: string;
  reservationUpdatedAt: string;
  paymentRecordedAt: string;
  amount: number;
  paymentMethod: string | null;
  referenceNo: string | null;
  notes: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const formData = new FormData(event.currentTarget);
    setError("");
    startTransition(async () => {
      try {
        const result = await editReservationPayment(formData);
        if (result.status === "error") {
          const message =
            EDIT_ERRORS[result.error] ?? EDIT_ERRORS["payment-edit-failed"];
          setError(
            result.diagnostic
              ? message + " (Database code: " + result.diagnostic + ")"
              : message,
          );
          return;
        }
        router.push(result.redirectTo);
        router.refresh();
      } catch {
        setError(EDIT_ERRORS["payment-edit-failed"]);
      }
    });
  }

  return (
    <>
      <button
        className="rounded-lg border border-border bg-white px-3 py-1.5 text-sm font-semibold text-ink transition hover:border-gold hover:bg-canvas"
        onClick={() => {
          setError("");
          setOpen(true);
        }}
        type="button"
      >
        Edit record
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !pending) setOpen(false);
          }}
        >
          <section
            aria-labelledby="edit-payment-title"
            aria-modal="true"
            className="my-auto w-full max-w-lg rounded-2xl border border-border bg-white p-6 shadow-2xl"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-serif text-2xl text-ink" id="edit-payment-title">
                  Edit payment record
                </h2>
                <p className="mt-1 text-sm text-muted">
                  Correct the amount or payment details for this reservation.
                </p>
              </div>
              <button
                aria-label="Close edit payment dialog"
                className="grid size-9 shrink-0 place-items-center rounded-full text-xl text-muted hover:bg-canvas hover:text-ink"
                disabled={pending}
                onClick={() => setOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>

            <form className="mt-5 space-y-4" onSubmit={submit}>
              <input name="paymentId" type="hidden" value={paymentId} />
              <input name="reservationId" type="hidden" value={reservationId} />
              <input name="expectedUpdatedAt" type="hidden" value={reservationUpdatedAt} />
              <input name="expectedPaymentRecordedAt" type="hidden" value={paymentRecordedAt} />

              <label className="block text-sm font-semibold text-ink">
                Amount
                <input
                  autoFocus
                  className="mt-1.5 h-11 w-full rounded-lg border border-border px-3 tabular-nums outline-none focus:border-gold"
                  name="amount"
                  required
                  step="0.01"
                  type="number"
                  defaultValue={amount.toFixed(2)}
                />
                <span className="mt-1 block text-xs font-normal text-muted">
                  Negative amounts are payment deductions.
                </span>
              </label>
              <label className="block text-sm font-semibold text-ink">
                Payment method <span className="font-normal text-muted">(optional)</span>
                <input
                  className="mt-1.5 h-11 w-full rounded-lg border border-border px-3 outline-none focus:border-gold"
                  maxLength={120}
                  name="paymentMethod"
                  defaultValue={paymentMethod ?? ""}
                />
              </label>
              <label className="block text-sm font-semibold text-ink">
                Reference number <span className="font-normal text-muted">(optional)</span>
                <input
                  className="mt-1.5 h-11 w-full rounded-lg border border-border px-3 outline-none focus:border-gold"
                  maxLength={200}
                  name="referenceNo"
                  defaultValue={referenceNo ?? ""}
                />
              </label>
              <label className="block text-sm font-semibold text-ink">
                Payment remarks <span className="font-normal text-muted">(optional)</span>
                <textarea
                  className="mt-1.5 min-h-24 w-full rounded-lg border border-border px-3 py-2 outline-none focus:border-gold"
                  maxLength={2000}
                  name="notes"
                  defaultValue={notes ?? ""}
                />
              </label>

              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-900">
                Saving keeps the original record in the audit history as voided and creates a corrected replacement. Evidence stays attached to the original record.
              </p>
              {error && (
                <p className="text-sm font-semibold text-red-700" role="alert">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-3 pt-1">
                <button
                  className="h-10 rounded-lg border border-border px-4 text-sm font-semibold text-ink hover:bg-canvas disabled:opacity-50"
                  disabled={pending}
                  onClick={() => setOpen(false)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="h-10 rounded-lg bg-gold px-4 text-sm font-bold text-white hover:bg-gold-dark disabled:opacity-50"
                  disabled={pending}
                  type="submit"
                >
                  {pending ? "Saving…" : "Save correction"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
