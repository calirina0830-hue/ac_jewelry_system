"use client";

import { useRouter } from "next/navigation";

import { usePaymentSubmissionPhase } from "@/components/reservations/payment-upload-form";

type PaymentFormActionsProps = {
  cancelHref: string;
  pricingIncomplete: boolean;
  reservationCount: number;
  singleReservationEditHref?: string;
};

export function PaymentFormActions({
  cancelHref,
  pricingIncomplete,
  reservationCount,
  singleReservationEditHref,
}: PaymentFormActionsProps) {
  const router = useRouter();
  const phase = usePaymentSubmissionPhase();
  const pending = phase !== "idle";

  const resetAndNavigate = (
    form: HTMLFormElement | null,
    destination: string,
  ) => {
    if (pending) return;
    form?.reset();
    router.push(destination);
  };

  return (
    <div className="flex flex-wrap gap-3">
      {pricingIncomplete && singleReservationEditHref ? (
        <button
          className="relative z-10 inline-flex h-11 items-center rounded-xl bg-gold px-5 text-sm font-bold text-ink transition hover:bg-gold-dark hover:text-white"
          disabled={pending}
          onClick={(event) =>
            resetAndNavigate(event.currentTarget.form, singleReservationEditHref)
          }
          type="button"
        >
          Complete pricing first
        </button>
      ) : (
        <button
          className="relative z-10 rounded-xl bg-gold px-6 py-3 text-sm font-black text-ink disabled:cursor-not-allowed disabled:opacity-50"
          disabled={pricingIncomplete || pending}
          title={
            pricingIncomplete
              ? "Complete pricing for every selected reservation before recording payments."
              : undefined
          }
          type="submit"
        >
          {phase === "uploading"
            ? "Uploading evidence..."
            : phase === "recording"
              ? "Recording payment..."
            : "Record " + (reservationCount === 1 ? "Payment" : "Payments")}
        </button>
      )}
      <button
        className="rounded-xl border border-border px-5 py-3 text-sm font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-50"
        disabled={pending}
        onClick={(event) =>
          resetAndNavigate(event.currentTarget.form, cancelHref)
        }
        type="button"
      >
        Cancel
      </button>
    </div>
  );
}
