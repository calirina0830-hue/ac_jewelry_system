"use client";

import { useEffect, useState } from "react";

import { formatCurrency, formatDateTime } from "@/lib/format";

export type PaymentEditHistoryEntry = {
  previousAmount: number;
  editedAmount: number;
  editedAt: string;
  editedBy: string;
};

export function PaymentEditHistory({
  entries,
}: {
  entries: PaymentEditHistoryEntry[];
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <>
      <button
        className="rounded-lg border border-border bg-white px-3 py-1.5 text-sm font-semibold text-ink transition hover:border-gold hover:bg-canvas"
        onClick={() => setOpen(true)}
        type="button"
      >
        Edit history
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            aria-labelledby="payment-edit-history-title"
            aria-modal="true"
            className="my-auto w-full max-w-xl rounded-2xl border border-border bg-white p-6 shadow-2xl"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2
                  className="font-serif text-2xl text-ink"
                  id="payment-edit-history-title"
                >
                  Payment edit history
                </h2>
                <p className="mt-1 text-sm text-muted">
                  Amount changes recorded for this payment.
                </p>
              </div>
              <button
                aria-label="Close payment edit history"
                className="grid size-9 shrink-0 place-items-center rounded-full text-xl text-muted hover:bg-canvas hover:text-ink"
                onClick={() => setOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>

            <ol className="mt-5 space-y-3">
              {entries.map((entry, index) => (
                <li
                  className="rounded-xl border border-border bg-canvas/50 p-4"
                  key={entry.editedAt + "-" + index}
                >
                  <p className="text-xs font-bold uppercase tracking-[0.14em] text-gold-dark">
                    Edit {index + 1}
                  </p>
                  <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-muted">Previous amount</dt>
                      <dd className="mt-1 font-semibold text-ink">
                        {formatCurrency(entry.previousAmount)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">Edited amount</dt>
                      <dd className="mt-1 font-black text-ink">
                        {formatCurrency(entry.editedAmount)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">Edited at</dt>
                      <dd className="mt-1 text-sm font-semibold text-ink">
                        {formatDateTime(entry.editedAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">Edited by</dt>
                      <dd className="mt-1 text-sm font-semibold text-ink">
                        {entry.editedBy}
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ol>

            <div className="mt-5 flex justify-end">
              <button
                className="h-10 rounded-lg border border-border px-4 text-sm font-semibold text-ink hover:bg-canvas"
                onClick={() => setOpen(false)}
                type="button"
              >
                Close
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
