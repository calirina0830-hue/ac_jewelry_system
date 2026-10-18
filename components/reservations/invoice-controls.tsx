"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { updateReservationInvoiceNotes } from "@/actions/reservations";
import { PrintInvoiceButton } from "@/components/reservations/print-invoice-button";

export function InvoiceActionBar({
  reservationId,
}: {
  reservationId: string;
}) {
  return (
    <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <PrintInvoiceButton />
        <a
          className="inline-flex h-11 items-center rounded-xl border border-border bg-white px-5 text-sm font-semibold text-ink transition hover:border-gold hover:bg-canvas"
          href={"/reservations/" + reservationId + "/invoice/pdf"}
        >
          Download PDF
        </a>
      </div>
    </div>
  );
}

export function InvoiceNotes({
  reservationId,
  updatedAt,
  notes,
  canWrite,
}: {
  reservationId: string;
  updatedAt: string;
  notes: string | null;
  canWrite: boolean;
}) {
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
