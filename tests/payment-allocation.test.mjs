import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateGroupPayment,
  combinePaymentSummaries,
  expandPaymentGroups,
} from "../lib/reservations/payment-allocation.ts";

const members = [
  { id: "older", capacity: 1000, paid: 100 },
  { id: "newer", capacity: 500, paid: 300 },
];

test("a payment fills the oldest reservation first", () => {
  assert.deepEqual(allocateGroupPayment(members, 120000), [
    { id: "older", cents: 100000 },
    { id: "newer", cents: 20000 },
  ]);
  assert.deepEqual(allocateGroupPayment(members, 40000), [
    { id: "older", cents: 40000 },
  ]);
});

test("an overpayment stays visible so the server rejects it", () => {
  const parts = allocateGroupPayment(members, 200000);
  assert.equal(parts.reduce((sum, part) => sum + part.cents, 0), 200000);
  assert.deepEqual(parts.at(-1), { id: "newer", cents: 100000 });
});

test("a deduction comes off the newest reservation first", () => {
  assert.deepEqual(allocateGroupPayment(members, -35000), [
    { id: "newer", cents: -30000 },
    { id: "older", cents: -5000 },
  ]);
});

test("one form entry becomes one entry per paid reservation", () => {
  const form = new FormData();
  form.set("amount:older", "1200.00");
  form.set("paymentMethod:older", "GCash");
  form.set("referenceNo:older", "REF1");
  form.set("notes:older", "note");

  const result = expandPaymentGroups(form, [members]);

  assert.deepEqual(result.reservationIds, ["older", "newer"]);
  assert.equal(form.get("reservationIds"), JSON.stringify(["older", "newer"]));
  assert.equal(form.get("amount:older"), "1000.00");
  assert.equal(form.get("amount:newer"), "200.00");
  assert.equal(form.get("paymentMethod:newer"), "GCash");
  assert.equal(result.evidenceSourceById.get("older"), "older");
  assert.equal(result.evidenceSourceById.has("newer"), false);
});

test("a partial payment leaves later reservations out of the batch", () => {
  const form = new FormData();
  form.set("amount:older", "300");
  assert.deepEqual(expandPaymentGroups(form, [members]).reservationIds, ["older"]);
});

test("invalid amounts reach the server unchanged", () => {
  const form = new FormData();
  form.set("amount:older", "abc");
  assert.deepEqual(expandPaymentGroups(form, [members]).reservationIds, ["older"]);
  assert.equal(form.get("amount:older"), "abc");
});

test("summaries combine into one customer total without rounding drift", () => {
  const base = {
    originalTotal: 0.1,
    remainingItemsSubtotal: 0.2,
    remainingReservationDiscount: 0,
    remainingItemsTotal: 0.2,
    totalPaid: 0.1,
    appliedToReleases: 0,
    paidTowardRemaining: 0.1,
    remainingBalance: 0.1,
    paymentCount: 1,
    items: [{ id: "a", label: "a", originalQuantity: 1, releasedQuantity: 0, remainingQuantity: 1, remainingTotal: 0.2 }],
  };
  const combined = combinePaymentSummaries([base, base, base]);
  assert.equal(combined.originalTotal, 0.3);
  assert.equal(combined.paymentCount, 3);
  assert.equal(combined.items.length, 3);
});
