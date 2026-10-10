"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  markReservationDelivered,
  updateReservationInvoiceNotes,
} from "@/actions/reservations";
import { recordReservationPayments } from "@/actions/payments";
import { PrintInvoiceButton } from "@/components/reservations/print-invoice-button";
import { formatCurrency } from "@/lib/format";

type InvoiceControlsProps = {
  reservationId: string;
  updatedAt: string;
  balance: number;
  deliveredAt: string | null;
  notes: string | null;
  canWrite: boolean;
  pricingComplete: boolean;
};

export function InvoiceActionBar({
  reservationId,
  updatedAt,
  balance,
  deliveredAt,
  canWrite,
  pricingComplete,
}: InvoiceControlsProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [feedback, setFeedback] = useState<{
    status: "success" | "error";
    message: string;
  } | null>(null);

  async function deliverReservation() {
    if (
      pending ||
      deliveredAt ||
      !window.confirm("Mark this reservation as delivered?")
    ) {
      return;
    }
    setPending(true);
    setFeedback(null);
    const result = await markReservationDelivered(reservationId, updatedAt);
    setPending(false);
    setFeedback(result);
    if (result.status === "success") router.refresh();
  }

  async function recordPayment(formData: FormData) {
    setPending(true);
    setFeedback(null);
    const result = await recordReservationPayments(formData);
    setPending(false);

    if (result.status === "success") {
      setPaymentDialogOpen(false);
      setFeedback({
        status: "success",
        message: "Payment recorded. Invoice totals have been updated.",
      });
      router.refresh();
      return;
    }

    const code = new URL(result.redirectTo, window.location.origin).searchParams.get(
      "error",
    );
    setFeedback({
      status: "error",
      message:
        code === "overpayment"
          ? "Payment cannot exceed the balance due."
          : code === "pricing-incomplete"
            ? "Complete item pricing before recording a payment."
            : code === "stale-reservation"
              ? "This reservation changed. Refresh the page and try again."
              : "Unable to record payment. Please review the payment details and try again.",
    });
  }

  function submitPayment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const formData = new FormData(event.currentTarget);
    formData.set("reservationIds", JSON.stringify([reservationId]));
    formData.set("updatedAt:" + reservationId, updatedAt);
    void recordPayment(formData);
  }

  return (
    <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {canWrite && (
          <>
            <button
              className="inline-flex h-11 items-center justify-center rounded-lg bg-black px-5 text-sm font-extrabold tracking-wide text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={pending || Boolean(deliveredAt)}
              onClick={deliverReservation}
              type="button"
            >
              {deliveredAt ? "DELIVERED" : "DELIVER"}
            </button>
            <button
              className="inline-flex h-11 items-center justify-center rounded-lg bg-black px-5 text-sm font-extrabold tracking-wide text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={pending || !pricingComplete || balance <= 0}
              onClick={() => {
                setFeedback(null);
                setPaymentDialogOpen(true);
              }}
              type="button"
            >
              PAID
            </button>
          </>
        )}
        <PrintInvoiceButton />
      </div>
      {feedback && (
        <p
          aria-live="polite"
          className={
            "w-full text-right text-xs font-semibold " +
            (feedback.status === "success" ? "text-emerald-700" : "text-red-700")
          }
          role="status"
        >
          {feedback.message}
        </p>
      )}
      {paymentDialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !pending) {
              setPaymentDialogOpen(false);
            }
          }}
        >
          <section
            aria-labelledby="invoice-payment-title"
            aria-modal="true"
            className="w-full max-w-lg rounded-2xl border border-border bg-white p-6 shadow-2xl"
            role="dialog"
          >
            <h2
              className="font-serif text-2xl text-ink"
              id="invoice-payment-title"
            >
              Record a payment
            </h2>
            <p className="mt-1 text-sm text-muted">
              Balance due:{" "}
              <span className="font-bold text-ink">
                {formatCurrency(balance)}
              </span>
              . Partial payments are supported.
            </p>
            <form className="mt-5 space-y-4" onSubmit={submitPayment}>
              <label className="block text-sm font-semibold text-ink">
                Amount received
                <input
                  autoFocus
                  className="mt-1.5 h-11 w-full rounded-lg border border-border px-3 tabular-nums outline-none focus:border-gold"
                  max={balance.toFixed(2)}
                  min="0.01"
                  name={"amount:" + reservationId}
                  required
                  step="0.01"
                  type="number"
                />
              </label>
              <label className="block text-sm font-semibold text-ink">
                Payment method <span className="font-normal text-muted">(optional)</span>
                <input
                  className="mt-1.5 h-11 w-full rounded-lg border border-border px-3 outline-none focus:border-gold"
                  maxLength={120}
                  name={"paymentMethod:" + reservationId}
                  placeholder="Cash, GCash, bank transfer"
                />
              </label>
              <label className="block text-sm font-semibold text-ink">
                Reference number <span className="font-normal text-muted">(optional)</span>
                <input
                  className="mt-1.5 h-11 w-full rounded-lg border border-border px-3 outline-none focus:border-gold"
                  maxLength={200}
                  name={"referenceNo:" + reservationId}
                />
              </label>
              <label className="block text-sm font-semibold text-ink">
                Payment remarks <span className="font-normal text-muted">(optional)</span>
                <textarea
                  className="mt-1.5 min-h-20 w-full rounded-lg border border-border px-3 py-2 outline-none focus:border-gold"
                  maxLength={2000}
                  name={"notes:" + reservationId}
                  rows={3}
                />
              </label>
              {feedback?.status === "error" && (
                <p aria-live="polite" className="text-sm font-medium text-red-700">
                  {feedback.message}
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2 pt-1">
                <button
                  className="h-10 rounded-lg border border-border px-4 text-sm font-semibold text-ink hover:bg-canvas disabled:opacity-50"
                  disabled={pending}
                  onClick={() => setPaymentDialogOpen(false)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="h-10 rounded-lg bg-black px-4 text-sm font-bold text-white hover:bg-neutral-800 disabled:opacity-50"
                  disabled={pending}
                  type="submit"
                >
                  {pending ? "Saving..." : "Confirm payment"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

export function InvoiceNotes({
  reservationId,
  updatedAt,
  notes,
  canWrite,
}: Pick<InvoiceControlsProps, "reservationId" | "updatedAt" | "notes" | "canWrite">) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{
    status: "success" | "error";
    message: string;
  } | null>(null);

  async function saveNotes(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFeedback(null);
    const formData = new FormData(event.currentTarget);
    const result = await updateReservationInvoiceNotes(
      reservationId,
      updatedAt,
      String(formData.get("notes") ?? ""),
    );
    setPending(false);
    setFeedback(result);
    if (result.status === "success") router.refresh();
  }

  return (
    <div className="border-t border-border pt-3 sm:text-left">
      <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-gold-dark">
        Notes
      </p>
      {canWrite ? (
        <form className="mt-2" data-print-hide onSubmit={saveNotes}>
          <textarea
            aria-label="Invoice notes"
            className="min-h-20 w-full resize-y rounded-lg border border-border bg-white px-3 py-2 text-xs leading-relaxed text-ink outline-none focus:border-gold"
            defaultValue={notes ?? ""}
            key={updatedAt}
            maxLength={4000}
            name="notes"
            placeholder="Customer instructions, payment remarks, delivery details, or special requests"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p
              aria-live="polite"
              className={
                "text-xs " +
                (feedback?.status === "error"
                  ? "text-red-700"
                  : "text-muted")
              }
              role={feedback ? "status" : undefined}
            >
              {feedback?.message ?? (notes ? "Saved notes appear on the printed invoice." : "No notes saved.")}
            </p>
            <button
              className="inline-flex h-9 items-center rounded-lg bg-ink px-4 text-xs font-bold text-white hover:bg-gold-dark disabled:opacity-50"
              disabled={pending}
              type="submit"
            >
              {pending ? "Saving..." : "Save notes"}
            </button>
          </div>
        </form>
      ) : (
        <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-ink">
          {notes || <span className="text-muted">No notes</span>}
        </p>
      )}
      <div className="hidden whitespace-pre-wrap text-xs leading-relaxed text-ink print:block">
        {notes || <span className="text-muted">No notes</span>}
      </div>
    </div>
  );
}
