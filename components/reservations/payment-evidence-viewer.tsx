"use client";

import { useEffect, useRef, useState } from "react";

import { StockImage } from "@/components/stock/stock-image";

export type PaymentEvidenceItem = {
  alt: string;
  url: string;
};

export function PaymentEvidenceViewer({
  items,
}: {
  items: PaymentEvidenceItem[];
}) {
  const [open, setOpen] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const current = items[currentIndex];

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      } else if (event.key === "ArrowLeft" && items.length > 1) {
        event.preventDefault();
        setCurrentIndex((index) => (index - 1 + items.length) % items.length);
      } else if (event.key === "ArrowRight" && items.length > 1) {
        event.preventDefault();
        setCurrentIndex((index) => (index + 1) % items.length);
      } else if (event.key === "Tab") {
        const controls = dialogRef.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        );
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [items.length, open]);

  if (!items.length) return null;

  const showViewer = (trigger: HTMLButtonElement, index: number) => {
    returnFocusRef.current = trigger;
    setCurrentIndex(index);
    setOpen(true);
  };

  return (
    <>
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">
        Evidence ({items.length})
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {items.map((item, index) => (
          <button
            aria-label={"Open " + item.alt}
            className="rounded-xl transition hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2"
            key={item.url}
            onClick={(event) => showViewer(event.currentTarget, index)}
            type="button"
          >
            <StockImage alt={item.alt} url={item.url} />
          </button>
        ))}
        <button
          className="rounded-md text-sm font-bold text-gold-dark hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2"
          onClick={(event) => showViewer(event.currentTarget, 0)}
          type="button"
        >
          View Evidence{items.length > 1 ? " (" + items.length + ")" : ""}
        </button>
      </div>

      {open && current && (
        <div
          aria-label="Payment evidence viewer"
          aria-modal="true"
          className="fixed inset-0 z-[100] overflow-y-auto bg-black/85 p-4 sm:p-6"
          onClick={(event) => {
            const target = event.target as HTMLElement;
            if (!target.closest("[data-evidence-content]")) setOpen(false);
          }}
          ref={dialogRef}
          role="dialog"
        >
          <button
            aria-label="Close payment evidence"
            className="fixed right-4 top-4 z-[102] grid size-11 place-items-center rounded-full border border-white/30 bg-black/70 text-2xl leading-none text-white shadow-lg transition hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:right-6 sm:top-6"
            data-evidence-content
            onClick={() => setOpen(false)}
            ref={closeButtonRef}
            type="button"
          >
            <span aria-hidden="true">×</span>
          </button>

          <div className="mx-auto flex min-h-full w-full max-w-7xl items-start justify-center pb-24 pt-14 sm:pt-16">
            {/* Authenticated evidence URLs do not expose intrinsic dimensions ahead of loading. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt={current.alt}
              className="h-auto max-w-full rounded-lg bg-white shadow-2xl"
              data-evidence-content
              src={current.url}
            />
          </div>

          <div
            className="fixed bottom-4 left-1/2 z-[102] flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/25 bg-black/80 p-2 text-white shadow-xl"
            data-evidence-content
          >
            <button
              aria-label="Previous evidence"
              className="rounded-full px-3 py-2 text-sm font-bold hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40"
              disabled={items.length < 2}
              onClick={() => setCurrentIndex((index) => (index - 1 + items.length) % items.length)}
              type="button"
            >
              Previous
            </button>
            <span aria-live="polite" className="min-w-16 text-center text-xs font-bold">
              {currentIndex + 1} of {items.length}
            </span>
            <button
              aria-label="Next evidence"
              className="rounded-full px-3 py-2 text-sm font-bold hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40"
              disabled={items.length < 2}
              onClick={() => setCurrentIndex((index) => (index + 1) % items.length)}
              type="button"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </>
  );
}
