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
      <div className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-border bg-[#fbf5e9] text-[#27231e] shadow-card">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b-4 border-[#d9b15f] bg-gradient-to-r from-[#5c0c1b] via-[#7a1424] to-[#6a1020] px-5 py-4">
          <div>
            <h2 className="font-serif text-2xl text-[#fff7e6]">Released</h2>
            <p className="text-xs text-[#f3e3c3]">
              {receipt.customerName} · {formatDate(releaseDateTime)}
            </p>
          </div>
          <button
            aria-label="Close"
            className="inline-flex size-9 items-center justify-center rounded-full text-xl leading-none text-[#fff3d6] transition hover:bg-white/10"
            onClick={onClose}
            title="Close"
            type="button"
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-auto overflow-y-auto px-5 py-4">
          <div className="overflow-x-auto rounded-2xl border-2 border-[#e0b75a] bg-[#fffdf8]">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gradient-to-b from-[#8a1b2b] to-[#6a0f1e] text-[10px] font-semibold uppercase tracking-[0.12em] text-[#fff3d6]">
                  <th className="px-3 py-2 text-left font-semibold">Item</th>
                  <th className="px-3 py-2 text-center font-semibold">Qty</th>
                  <th className="px-3 py-2 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody>
                {receipt.lines.map((line) => (
                  <tr className="border-t border-[#ead9b8]" key={line.key}>
                    <td className="px-3 py-2 font-semibold text-[#2b1d1d]">{line.name}</td>
                    <td className="px-3 py-2 text-center text-[#2b1d1d]">{line.quantity}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#2b1d1d]">
                      {formatCurrency(line.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="mt-4 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-[#6b5a4e]">Released value</dt>
              <dd className="font-semibold text-[#2b1d1d]">{formatCurrency(releasedValue)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[#6b5a4e]">Downpayment applied</dt>
              <dd className="font-semibold text-[#2b1d1d]">
                {formatCurrency(receipt.appliedDownpayment)}
              </dd>
            </div>
          </dl>

          <div className="mt-3 flex items-center justify-between gap-4 rounded-2xl border-2 border-[#e0b75a] bg-gradient-to-r from-[#5c0c1b] via-[#7a1424] to-[#5c0c1b] px-5 py-3 shadow-md">
            <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#fbe7b5]">
              To collect (COD)
            </span>
            <span className="whitespace-nowrap font-serif text-xl font-bold tabular-nums text-[#f6dd9a]">
              {formatCurrency(toCollect)}
            </span>
          </div>

          {receipt.shipments.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {receipt.shipments.map((shipment) => (
                <a
                  className="inline-flex h-9 items-center rounded-xl border-2 border-[#e0b75a] bg-[#fffdf8] px-3 text-xs font-bold text-[#7a1424] transition hover:bg-[#fff7e6]"
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

        <footer className="flex shrink-0 justify-end border-t-4 border-[#d9b15f] bg-gradient-to-r from-[#5c0c1b] via-[#7a1424] to-[#5c0c1b] px-5 py-3">
          <button
            className="inline-flex h-10 items-center rounded-xl border-2 border-[#e9c46a] bg-[#fbf5e9] px-4 text-sm font-bold text-[#7a1424] transition hover:bg-[#fff7e6]"
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
