"use client";

import { useEffect } from "react";

import { formatCurrency, formatDate } from "@/lib/format";

export type ReleaseReceipt = {
  customerName: string;
  // YYYY-MM-DD, as typed in the release form.
  releaseDate: string;
  lines: Array<{ key: string; name: string; quantity: number; amount: number }>;
  appliedDownpayment: number;
  shipments: Array<{ id: string; no: string | null }>;
};

/**
 * Shown right after a successful release: what was released, the downpayment
 * applied to it, and the release slip PDF(s). Styled like the invoice it
 * came from (cream paper, maroon bands, gold edges) so it looks the same in
 * both themes. Closes with ×, Escape or the Done button.
 */
export function ReleaseReceiptModal({
  receipt,
  onClose,
}: {
  receipt: ReleaseReceipt;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const releasedValue = receipt.lines.reduce((sum, line) => sum + line.amount, 0);
  const totalQuantity = receipt.lines.reduce((sum, line) => sum + line.quantity, 0);
  const toCollect = Math.max(releasedValue - receipt.appliedDownpayment, 0);
  const releaseDateTime = receipt.releaseDate.includes("T")
    ? receipt.releaseDate
    : receipt.releaseDate + "T12:00:00Z";

  return (
    <div
      aria-label="Released items"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/40 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-border bg-[#fff5f9] text-[#27231e] shadow-card">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b-4 border-[#ef9ac3] bg-gradient-to-r from-[#9c1f5f] via-[#b8306f] to-[#a8266a] px-5 py-4">
          <div>
            <h2 className="font-serif text-2xl text-[#ffeef5]">Released</h2>
            <p className="text-xs text-[#fbd6e6]">
              {receipt.customerName} · {formatDate(releaseDateTime)}
            </p>
          </div>
          <button
            aria-label="Close"
            className="inline-flex size-9 items-center justify-center rounded-full text-xl leading-none text-[#fff0f6] transition hover:bg-white/10"
            onClick={onClose}
            title="Close"
            type="button"
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-auto overflow-y-auto px-5 py-4">
          <div className="overflow-x-auto rounded-2xl border-2 border-[#ef9ac3] bg-[#fffafc]">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gradient-to-b from-[#d63d8a] to-[#a8266a] text-[10px] font-semibold uppercase tracking-[0.12em] text-[#fff0f6]">
                  <th className="px-3 py-2 text-left font-semibold">Item</th>
                  <th className="px-3 py-2 text-center font-semibold">Qty</th>
                  <th className="px-3 py-2 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody>
                {receipt.lines.map((line) => (
                  <tr className="border-t border-[#f3d0df]" key={line.key}>
                    <td className="px-3 py-2 font-semibold text-[#3a1a2a]">{line.name}</td>
                    <td className="px-3 py-2 text-center text-[#3a1a2a]">{line.quantity}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#3a1a2a]">
                      {formatCurrency(line.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[#ef9ac3] bg-[#ffeef5] font-bold text-[#b8306f]">
                  <td className="px-3 py-2 text-left text-[11px] uppercase tracking-[0.12em]">
                    Total
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums">{totalQuantity}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatCurrency(releasedValue)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <dl className="mt-4 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-[#86707b]">Released value</dt>
              <dd className="font-semibold text-[#3a1a2a]">{formatCurrency(releasedValue)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[#86707b]">Downpayment applied</dt>
              <dd className="font-semibold text-[#3a1a2a]">
                {formatCurrency(receipt.appliedDownpayment)}
              </dd>
            </div>
          </dl>

          <div className="mt-3 flex items-center justify-between gap-4 rounded-2xl border-2 border-[#ef9ac3] bg-gradient-to-r from-[#9c1f5f] via-[#b8306f] to-[#9c1f5f] px-5 py-3 shadow-md">
            <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#ffe4f0]">
              To collect (COD)
            </span>
            <span className="whitespace-nowrap font-serif text-xl font-bold tabular-nums text-[#ffffff]">
              {formatCurrency(toCollect)}
            </span>
          </div>

          {receipt.shipments.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {receipt.shipments.map((shipment) => (
                <a
                  className="inline-flex h-9 items-center rounded-xl border-2 border-[#ef9ac3] bg-[#fffafc] px-3 text-xs font-bold text-[#b8306f] transition hover:bg-[#ffeef5]"
                  href={"/shipments/" + shipment.id + "/pdf"}
                  key={shipment.id}
                  rel="noopener"
                  target="_blank"
                >
                  {shipment.no ? "Release slip " + shipment.no : "Release slip PDF"}
                </a>
              ))}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 justify-end border-t-4 border-[#ef9ac3] bg-gradient-to-r from-[#9c1f5f] via-[#b8306f] to-[#9c1f5f] px-5 py-3">
          <button
            className="inline-flex h-10 items-center rounded-xl border-2 border-[#ffd6e8] bg-[#fff5f9] px-4 text-sm font-bold text-[#b8306f] transition hover:bg-[#ffeef5]"
            onClick={onClose}
            type="button"
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
