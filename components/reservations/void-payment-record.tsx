"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

import { voidReservationPayment } from "@/actions/payments";
import { formatCurrency } from "@/lib/format";

export function VoidPaymentRecord({
  paymentId,
  reservationId,
  reservationUpdatedAt,
  paymentRecordedAt,
  amount,
}: {
  paymentId: string;
  reservationId: string;
  reservationUpdatedAt: string;
  paymentRecordedAt: string;
  amount: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-semibold text-red-700 transition hover:bg-red-50"
        onClick={() => setOpen(true)}
        type="button"
      >
        Void payment
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            aria-labelledby="void-payment-title"
            aria-modal="true"
            className="w-full max-w-lg rounded-2xl border border-border bg-white p-6 shadow-2xl"
            role="dialog"
          >
            <h2 className="font-serif text-2xl text-ink" id="void-payment-title">
              Void payment record?
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              This will remove {formatCurrency(amount)} from the active totals.
              The original payment will remain in the audit history.
            </p>

            <form action={voidReservationPayment} className="mt-5 space-y-4">
              <input name="paymentId" type="hidden" value={paymentId} />
              <input name="reservationId" type="hidden" value={reservationId} />
              <input name="expectedUpdatedAt" type="hidden" value={reservationUpdatedAt} />
              <input
                name="expectedPaymentRecordedAt"
                type="hidden"
                value={paymentRecordedAt}
              />

              <label className="block text-sm font-semibold text-ink">
                Reason for voiding <span className="text-red-700">*</span>
                <textarea
                  autoFocus
                  className="mt-2 min-h-28 w-full rounded-lg border border-border px-3 py-2 font-normal outline-none focus:border-gold"
                  maxLength={1000}
                  minLength={3}
                  name="remarks"
                  placeholder="Explain why this payment is being voided."
                  required
                />
                <span className="mt-1 block text-xs font-normal text-muted">
                  This reason will be visible in the voided payment audit.
                </span>
              </label>

              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-900">
                Confirming will void the payment. It will not be physically deleted.
              </div>

              <div className="flex justify-end gap-3 pt-1">
                <button
                  className="h-10 rounded-lg border border-border px-4 text-sm font-semibold text-ink hover:bg-canvas disabled:opacity-50"
                  onClick={() => setOpen(false)}
                  type="button"
                >
                  Cancel
                </button>
                <VoidSubmitButton />
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}

function VoidSubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      className="h-10 rounded-lg bg-red-700 px-4 text-sm font-bold text-white hover:bg-red-800 disabled:opacity-50"
      disabled={pending}
      type="submit"
    >
      {pending ? "Voiding..." : "Confirm void"}
    </button>
  );
}
