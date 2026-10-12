"use client";

import Link from "next/link";
import { useState } from "react";

import { PaymentEvidenceInput } from "@/components/reservations/payment-evidence-input";
import { formatCurrency } from "@/lib/format";

export type RecordPaymentCustomer = {
  name: string | null;
  facebook_name: string | null;
};

export type RecordPaymentReservation = {
  id: string;
  reservation_no: string;
  total: number;
  downpayment: number;
  balance: number;
  updated_at: string;
  pricing_complete: boolean;
};

export function RecordPaymentCard({
  reservation,
  customer,
}: {
  reservation: RecordPaymentReservation;
  customer: RecordPaymentCustomer;
}) {
  const [amount, setAmount] = useState(() =>
    Number(reservation.balance).toFixed(2),
  );
  const parsed = Number(amount);
  const payment = Number.isFinite(parsed) ? parsed : 0;
  const totalPaid = reservation.downpayment + payment;
  const remaining = Math.max(reservation.balance - payment, 0);

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
        <div className="grid grid-cols-3 gap-4 text-right">
          <div>
            <p className="text-xs text-muted">Reservation total</p>
            <p className="mt-1 text-sm font-bold text-ink">
              {formatCurrency(reservation.total)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">Current total paid</p>
            <p className="mt-1 text-sm font-bold text-ink">
              {formatCurrency(totalPaid)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">Current remaining balance</p>
            <p className="mt-1 text-lg font-black text-ink">
              {formatCurrency(remaining)}
            </p>
          </div>
        </div>
      </div>
      <input
        name={"updatedAt:" + reservation.id}
        type="hidden"
        value={reservation.updated_at}
      />
      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <label className="block text-sm font-semibold text-ink">
          Payment amount
          <input
            className="mt-2 h-11 w-full rounded-xl border border-border px-4 font-normal outline-none focus:border-gold"
            inputMode="decimal"
            max={Number(reservation.balance).toFixed(2)}
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