"use client";

export function PrintInvoiceButton() {
  return (
    <button
      className="inline-flex h-11 items-center rounded-xl bg-ink px-5 text-sm font-bold text-white hover:bg-gold-dark"
      onClick={() => window.print()}
      type="button"
    >
      Print Invoice
    </button>
  );
}
