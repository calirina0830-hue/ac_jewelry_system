import type { ReactNode } from "react";

import { BUSINESS } from "@/lib/constants/business";
import type {
  CustomerInvoice,
  CustomerInvoiceSummary,
} from "@/lib/reservations/customer-invoice";

// Fixed pink palette: this is printed paper, so it looks the same in both
// themes.
const PINK = "#d63d8a";
const PLUM = "#8a1a4f";
const HEAD_BG = "#f7dce8";
const STRIPE_BG = "#fff0f5";

const pesoWhole = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  maximumFractionDigits: 0,
});
const pesoCents = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// ₱8,800 for whole amounts, ₱8,800.50 when there are centavos.
function peso(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? pesoWhole.format(rounded) : pesoCents.format(rounded);
}

const monthDay = new Intl.DateTimeFormat("en-PH", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});
const monthDayYear = new Intl.DateTimeFormat("en-PH", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

function dayLabel(dateKey: string, currentYear: string) {
  if (!dateKey) return "No date";
  const date = new Date(dateKey + "T00:00:00Z");
  return dateKey.startsWith(currentYear) ? monthDay.format(date) : monthDayYear.format(date);
}

const manilaYear = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Manila",
  year: "numeric",
});
const manilaMonthDayTime = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const manilaFullDateTime = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

// "Nov 18, 2:35 PM" in Manila time; the year is added for other years.
function dateTimeLabel(value: string, currentYear: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No date";
  return manilaYear.format(date) === currentYear
    ? manilaMonthDayTime.format(date)
    : manilaFullDateTime.format(date);
}

function itemsLabel(quantity: number) {
  return quantity + (quantity === 1 ? " item" : " items");
}

function SectionBar({ children }: { children: ReactNode }) {
  return (
    <h2
      className="mt-5 rounded-2xl px-5 py-2 text-lg font-bold uppercase tracking-wide text-white"
      style={{ backgroundColor: PINK, breakAfter: "avoid" }}
    >
      {children}
    </h2>
  );
}

function Table({
  columns,
  rows,
  total,
  empty,
}: {
  columns: Array<{ label: string; align?: "left" | "center" | "right" }>;
  rows: ReactNode[][];
  total: ReactNode[];
  empty: string;
}) {
  const alignClass = (align?: "left" | "center" | "right") =>
    align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return (
    <div className="mx-2 mt-2">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr style={{ backgroundColor: HEAD_BG, color: PLUM }}>
            {columns.map((column, index) => (
              <th
                className={
                  "px-3 py-2 text-xs font-bold uppercase tracking-wide " +
                  alignClass(column.align) +
                  (index === 0 ? " rounded-l-lg" : "") +
                  (index === columns.length - 1 ? " rounded-r-lg" : "")
                }
                key={column.label}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="px-3 py-2 text-center italic text-[#86707b]" colSpan={columns.length}>
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((cells, rowIndex) => (
              <tr
                key={rowIndex}
                style={{ backgroundColor: rowIndex % 2 === 1 ? STRIPE_BG : "#ffffff" }}
              >
                {cells.map((cell, index) => (
                  <td
                    className={"px-3 py-1.5 tabular-nums text-[#2b1a23] " + alignClass(columns[index]?.align)}
                    key={index}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr className="font-bold" style={{ backgroundColor: HEAD_BG, color: PLUM }}>
            {total.map((cell, index) => (
              <td
                className={
                  "px-3 py-2 tabular-nums " +
                  (index === 0 ? "rounded-l-lg uppercase " : "") +
                  (index === total.length - 1 ? "rounded-r-lg " : "") +
                  alignClass(columns[index]?.align)
                }
                key={index}
              >
                {cell}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  note,
  highlight = false,
}: {
  label: string;
  value: string;
  note?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className="rounded-xl border px-3 py-3 text-center"
      style={
        highlight
          ? { backgroundColor: "#fde9b8", borderColor: "#d4a537" }
          : { backgroundColor: "#fdeef4", borderColor: "#dba3bf" }
      }
    >
      <p className="text-xs font-bold uppercase tracking-wide" style={{ color: PLUM }}>
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold tabular-nums" style={{ color: PLUM }}>
        {value}
      </p>
      {note && <p className="text-xs text-[#2b1a23]">{note}</p>}
    </div>
  );
}

export function InvoiceSummarySheet({
  invoice,
  generatedAt,
}: {
  invoice: CustomerInvoice;
  generatedAt: Date;
}) {
  const summary: CustomerInvoiceSummary = invoice.summary;
  const totals = summary.totals;
  const currentYear = String(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric" }).format(
      generatedAt,
    ),
  );
  const label = (dateKey: string) => dayLabel(dateKey, currentYear);
  const generatedLabel = new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(generatedAt);
  const displayName = invoice.facebookName || invoice.customerName;

  return (
    <article
      className="mx-auto w-full max-w-[860px] bg-[#fff8fb] p-4 text-[#2b1a23] sm:p-6"
      data-print-summary
    >
      <header
        className="flex flex-wrap items-end justify-between gap-3 rounded-3xl px-6 py-4 text-white"
        style={{ backgroundColor: PINK }}
      >
        <div>
          <h1 className="text-4xl font-black uppercase tracking-wide">Invoice Summary</h1>
          <p className="mt-1 text-sm font-bold uppercase tracking-wide">
            Mined items • Downpayments • Released items
          </p>
        </div>
        <div className="text-right text-xs uppercase tracking-wide">
          <p className="font-bold">{BUSINESS.name}</p>
          <p className="opacity-90">As of {generatedLabel}</p>
        </div>
      </header>

      <div className="mt-3 flex flex-wrap justify-between gap-2 px-2 text-sm">
        <p>
          <span className="font-bold uppercase tracking-wide" style={{ color: PLUM }}>
            Customer:
          </span>{" "}
          <span className="font-semibold">{displayName}</span>
          {invoice.facebookName && invoice.facebookName !== invoice.customerName && (
            <span className="text-[#86707b]"> ({invoice.customerName})</span>
          )}
        </p>
        {invoice.phone && <p className="text-[#86707b]">{invoice.phone}</p>}
      </div>

      <SectionBar>1. Mined items</SectionBar>
      <Table
        columns={[
          { label: "Order date" },
          { label: "Amount", align: "right" },
          { label: "Qty", align: "center" },
        ]}
        empty="No items."
        rows={summary.mined.map((row) => [
          label(row.dateKey),
          peso(row.amount),
          row.quantity,
        ])}
        total={["Total mined", peso(totals.mined), itemsLabel(totals.minedQuantity)]}
      />

      <SectionBar>2. Downpayments received</SectionBar>
      <Table
        columns={[{ label: "Date received" }, { label: "Downpayment", align: "right" }]}
        empty="No downpayment yet."
        rows={summary.downpayments.map((row) => [
          row.recordedAt ? dateTimeLabel(row.recordedAt, currentYear) : "Recorded earlier",
          peso(row.amount),
        ])}
        total={["Total DP received", peso(totals.downpayment)]}
      />

      <SectionBar>3. Released items</SectionBar>
      <Table
        columns={[
          { label: "Release date" },
          { label: "Order date" },
          { label: "Amount", align: "right" },
          { label: "Qty", align: "center" },
          { label: "DP applied", align: "right" },
          { label: "COD", align: "right" },
        ]}
        empty="Nothing released yet."
        rows={summary.releases.map((release) => [
          label(release.releaseDateKey),
          release.orderDateKeys.map(label).join(", ") || "—",
          peso(release.amount),
          release.quantity,
          peso(release.downpaymentApplied),
          peso(release.cod),
        ])}
        total={[
          "Total released",
          "",
          peso(totals.released),
          itemsLabel(totals.releasedQuantity),
          peso(totals.appliedDownpayment),
          peso(totals.cod),
        ]}
      />

      <SectionBar>4. Remaining items / not yet released</SectionBar>
      <Table
        columns={[
          { label: "Order date" },
          { label: "Amount", align: "right" },
          { label: "Qty", align: "center" },
        ]}
        empty="Everything has been released."
        rows={summary.remaining.map((row) => [
          label(row.dateKey),
          peso(row.amount),
          row.quantity,
        ])}
        total={[
          "Total remaining",
          peso(totals.remaining),
          itemsLabel(totals.remainingQuantity),
        ]}
      />

      <section
        className="relative mx-2 mt-10 rounded-3xl border-2 px-3 pb-4 pt-9"
        style={{ borderColor: "#c45a8e", breakInside: "avoid" }}
      >
        <h2
          className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-2xl px-10 py-2 text-lg font-bold uppercase tracking-wide text-white"
          style={{ backgroundColor: PINK }}
        >
          Overall summary
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SummaryCard
            label="Total mined"
            note={itemsLabel(totals.minedQuantity)}
            value={peso(totals.mined)}
          />
          <SummaryCard
            label="Total released"
            note={itemsLabel(totals.releasedQuantity)}
            value={peso(totals.released)}
          />
          <SummaryCard
            label="Remaining items"
            note={itemsLabel(totals.remainingQuantity)}
            value={peso(totals.remaining)}
          />
          <SummaryCard label="Total DP received" value={peso(totals.downpayment)} />
          <SummaryCard
            highlight
            label="Remaining DP"
            value={peso(totals.remainingDownpayment)}
          />
          <SummaryCard label="Remaining balance" value={peso(totals.remainingBalance)} />
        </div>
        <p className="mt-4 text-xs">
          Balance = {peso(totals.remaining)} remaining items − {peso(totals.remainingDownpayment)}{" "}
          unapplied DP = {peso(totals.remainingBalance)}.
        </p>
      </section>
    </article>
  );
}
