"use client";

import Link from "next/link";
import { useState } from "react";

import { PaymentEvidenceInput } from "@/components/reservations/payment-evidence-input";
import { formatCurrency } from "@/lib/format";
import type { PaymentTransactionSummary } from "@/lib/reservations/payment-transaction";

export type RecordPaymentCustomer = {
  name: string | null;
  facebook_name: string | null;
};

export type RecordPaymentReservation = {
  id: string;
  reservation_no: string;
  updated_at: string;
  pricing_complete: boolean;
  transaction: PaymentTransactionSummary;
};

export function RecordPaymentCard({
  reservation,
  customer,
  settlementBalance,
}: {
  reservation: RecordPaymentReservation;
  customer: RecordPaymentCustomer;
  settlementBalance?: number;
}) {
  const transaction = reservation.transaction;
  const amountDue = settlementBalance ?? transaction.remainingBalance;
  const [amount, setAmount] = useState(() =>
    amountDue.toFixed(2),
  );
  const parsed = Number(amount);
  const payment = Number.isFinite(parsed) ? parsed : 0;
  const projectedPaidTowardRemaining = transaction.paidTowardRemaining + payment;
  const remainingAfterPayment =
    settlementBalance === undefined
      ? Math.max(
          transaction.remainingItemsTotal - projectedPaidTowardRemaining,
          0,
        )
      : Math.max(amountDue - payment, 0);

  return (
    <section className="rounded-3xl border border-border bg-white p-6 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-5">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.15em] text-gold-dark">
            {reservation.reservation_no}
          </p>
          <h2 className="mt-1 font-serif text-2xl text-ink">
            {customer.name ?? "Customer unavailable"}
          </h2>
          {customer.facebook_name && (
            <p className="mt-1 text-xs text-muted">
              Facebook / CS: {customer.facebook_name}
            </p>
          )}
        </div>
        {settlementBalance === undefined ? (
          <div className="grid grid-cols-2 gap-4 text-right sm:grid-cols-4">
            <div>
              <p className="text-xs text-muted">Original transaction</p>
              <p className="mt-1 text-sm font-bold text-ink">
                {formatCurrency(transaction.originalTotal)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted">Amount items to be paid</p>
              <p className="mt-1 text-sm font-bold text-ink">
                {formatCurrency(transaction.remainingItemsTotal)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted">Total paid</p>
              <p className="mt-1 text-sm font-bold text-ink">
                {formatCurrency(transaction.totalPaid)}
              </p>
              <p className="mt-0.5 text-[11px] text-muted">
                {transaction.paymentCount} active payment record{transaction.paymentCount === 1 ? "" : "s"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted">Remaining to pay</p>
              <p className="mt-1 text-lg font-black text-ink">
                {formatCurrency(amountDue)}
              </p>
            </div>
          </div>
        ) : (
          <dl className="grid gap-4 text-right sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted">Order total</dt>
              <dd className="mt-1 text-sm font-bold text-ink">
                {formatCurrency(transaction.originalTotal)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Total Paid</dt>
              <dd className="mt-1 text-sm font-bold text-ink">
                {formatCurrency(transaction.totalPaid)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Balance due</dt>
              <dd className="mt-1 text-lg font-black text-emerald-700">
                {formatCurrency(amountDue)}
              </dd>
            </div>
          </dl>
        )}
      </div>
      {settlementBalance !== undefined && (
        <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-emerald-900">
          Enter the balance due to complete this order.
        </div>
      )}
      {settlementBalance === undefined && <div className="mt-5 overflow-hidden rounded-2xl border border-border">
        <div className="border-b border-border bg-canvas px-4 py-3">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">
            Items still requiring payment
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted">
              <tr>
                <th className="px-4 py-3 font-semibold">Item</th>
                <th className="px-4 py-3 text-right font-semibold">Original qty.</th>
                <th className="px-4 py-3 text-right font-semibold">Released</th>
                <th className="px-4 py-3 text-right font-semibold">Remaining</th>
                <th className="px-4 py-3 text-right font-semibold">Remaining value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {transaction.items.map((item) => (
                <tr key={item.id}>
                  <td className="px-4 py-3 font-semibold text-ink">{item.label}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{item.originalQuantity}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{item.releasedQuantity}</td>
                  <td className="px-4 py-3 text-right font-bold tabular-nums text-ink">{item.remainingQuantity}</td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-ink">
                    {formatCurrency(item.remainingTotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="grid gap-3 border-t border-border bg-canvas/40 px-4 py-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Summary label="Item subtotal" value={transaction.remainingItemsSubtotal} />
          <Summary label="Transaction discount" value={transaction.remainingReservationDiscount} />
          <Summary label="Applied to releases" value={transaction.appliedToReleases} />
          <Summary label="Paid toward remaining" value={transaction.paidTowardRemaining} />
        </dl>
      </div>}
      <input
        name={"updatedAt:" + reservation.id}
        type="hidden"
        value={reservation.updated_at}
      />
      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <label className="block text-sm font-semibold text-ink">
          {settlementBalance === undefined ? "Payment amount" : "Settlement amount"}
          <input
            className="mt-2 h-11 w-full rounded-xl border border-border px-4 font-normal outline-none focus:border-gold"
            inputMode="decimal"
            max={amountDue.toFixed(2)}
            name={"amount:" + reservation.id}
            onChange={(event) => setAmount(event.target.value)}
            required
            step="0.01"
            type="number"
            value={amount}
          />
        </label>
        <label className="block text-sm font-semibold text-ink">
          Payment method <span className="font-normal text-muted">(optional)</span>
          <input
            className="mt-2 h-11 w-full rounded-xl border border-border px-4 font-normal outline-none focus:border-gold"
            maxLength={120}
            name={"paymentMethod:" + reservation.id}
            placeholder="Cash, GCash, bank transfer"
          />
        </label>
        <label className="block text-sm font-semibold text-ink">
          Reference number <span className="font-normal text-muted">(optional)</span>
          <input
            className="mt-2 h-11 w-full rounded-xl border border-border px-4 font-normal outline-none focus:border-gold"
            maxLength={200}
            name={"referenceNo:" + reservation.id}
          />
        </label>
        <PaymentEvidenceInput name={"evidence:" + reservation.id} />
        <label className="block text-sm font-semibold text-ink md:col-span-2">
          Payment notes <span className="font-normal text-muted">(optional)</span>
          <textarea
            className="mt-2 min-h-24 w-full rounded-xl border border-border px-4 py-3 font-normal outline-none focus:border-gold"
            maxLength={2000}
            name={"notes:" + reservation.id}
          />
        </label>
      </div>
      <dl className="mt-5 rounded-2xl border border-gold/30 bg-gold/5 p-4">
        <Summary
          label="Balance after this payment"
          value={remainingAfterPayment}
        />
      </dl>
      {!reservation.pricing_complete && (
        <Link
          className="mt-4 inline-flex text-sm font-bold text-gold-dark hover:underline"
          href={"/reservations/" + reservation.id + "/edit"}
        >
          Complete item pricing
        </Link>
      )}
    </section>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3 sm:block">
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="mt-1 font-bold tabular-nums text-ink">{formatCurrency(value)}</dd>
    </div>
  );
}
