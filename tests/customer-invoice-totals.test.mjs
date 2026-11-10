import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  allocateAppliedDownpayment,
  computeCycleTotals,
  computeReleasePreview,
  selectBillableOrders,
  selectCurrentCycle,
} from "../lib/reservations/customer-cycle.ts";
import {
  getReleaseValue,
  selectCustomerInvoiceItems,
} from "../lib/reservations/customer-invoice-selection.ts";
import { releaseItemsSchema } from "../lib/validation/shipments.ts";

function order(amounts) {
  return {
    remainingTotal: 0,
    releasedTotal: 0,
    paid: 0,
    appliedShipped: 0,
    appliedPending: 0,
    ...amounts,
  };
}

function cycleOrder(id, createdAt, remainingUnits, lastReleaseAt = null) {
  return { id, createdAt, remainingUnits, lastReleaseAt };
}

test("orders and downpayments add up before anything is released", () => {
  const totals = computeCycleTotals([
    order({ remainingTotal: 500, paid: 500 }),
    order({ remainingTotal: 1000, paid: 500 }),
    order({ remainingTotal: 2000 }),
  ]);
  assert.equal(totals.remainingTotal, 3500);
  assert.equal(totals.remainingDownpayment, 1000);
  assert.equal(totals.remainingBalance, 2500);
  assert.equal(totals.released, 0);
});

test("releasing 2000 with 300 applied leaves 1500, 700 and 800", () => {
  const totals = computeCycleTotals([
    order({ remainingTotal: 500, paid: 500 }),
    order({ remainingTotal: 1000, paid: 500 }),
    order({ releasedTotal: 2000, appliedShipped: 300 }),
  ]);
  assert.equal(totals.totalItems, 3500);
  assert.equal(totals.downpayment, 1000);
  assert.equal(totals.balance, 2500);
  assert.equal(totals.released, 2000);
  assert.equal(totals.appliedDownpayment, 300);
  assert.equal(totals.cod, 1700);
  assert.equal(totals.remainingTotal, 1500);
  assert.equal(totals.remainingDownpayment, 700);
  assert.equal(totals.remainingBalance, 800);
  assert.equal(totals.availableDownpayment, 700);
});

test("the sample gives the same result when everything is one order", () => {
  const totals = computeCycleTotals([
    order({ remainingTotal: 1500, releasedTotal: 2000, paid: 1000, appliedShipped: 300 }),
  ]);
  assert.equal(totals.remainingDownpayment, 700);
  assert.equal(totals.remainingBalance, 800);
  assert.equal(totals.cod, 1700);
});

test("downpayment already held or used cannot be deducted again", () => {
  const totals = computeCycleTotals([
    order({ remainingTotal: 500, paid: 1000, appliedShipped: 300, appliedPending: 200 }),
  ]);
  assert.equal(totals.availableDownpayment, 500);

  const usedUp = computeCycleTotals([
    order({ remainingTotal: 500, paid: 300, appliedShipped: 300 }),
  ]);
  assert.equal(usedUp.availableDownpayment, 0);
});

test("the downpayment shown never exceeds the remaining items", () => {
  const totals = computeCycleTotals([order({ remainingTotal: 500, paid: 700 })]);
  assert.equal(totals.remainingDownpayment, 500);
  assert.equal(totals.remainingBalance, 0);
  assert.equal(totals.availableDownpayment, 700);
});

test("cancelled, deleted, and hand-delivered orders are not billed", () => {
  const row = (id, fields = {}) => ({
    id,
    status: "reserved",
    archived_at: null,
    delivered_at: null,
    ...fields,
  });
  const orders = [
    row("open"),
    row("cancelled", { status: "cancelled" }),
    row("deleted", { archived_at: "2026-11-09T00:00:00Z" }),
    row("marked", { delivered_at: "2026-11-09T00:00:00Z" }),
    row("partly-released", { delivered_at: "2026-11-09T00:00:00Z" }),
  ];
  const billable = selectBillableOrders(
    orders,
    (id) => id === "partly-released",
    () => true,
  );
  assert.deepEqual(billable.map((order) => order.id), ["open", "partly-released"]);
});

test("a customer with only closed orders can still open their invoice", () => {
  const closed = [
    { id: "marked", status: "reserved", archived_at: null, delivered_at: "2026-11-09T00:00:00Z" },
  ];
  assert.deepEqual(
    selectBillableOrders(closed, () => false, () => true).map((order) => order.id),
    ["marked"],
  );

  const cancelledOnly = [
    { id: "cancelled", status: "cancelled", archived_at: null, delivered_at: null },
  ];
  assert.equal(selectBillableOrders(cancelledOnly, () => false, () => true).length, 1);
});

test("a new order does not join a reservation marked delivered by hand", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/202611100006_new_reservation_skips_marked_delivered.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /reservation\.delivered_at is null/);
  assert.match(migration, /shipment\.status = ''shipped''/);
});

test("the computation restarts only after everything was released", () => {
  const cycle = selectCurrentCycle([
    cycleOrder("old", "2026-11-01T00:00:00Z", 0, "2026-11-02T00:00:00Z"),
    cycleOrder("new", "2026-11-03T00:00:00Z", 1),
  ]);
  assert.deepEqual(cycle.map((entry) => entry.id), ["new"]);
});

test("an order placed while items were waiting stays in the computation", () => {
  const cycle = selectCurrentCycle([
    cycleOrder("first", "2026-11-01T00:00:00Z", 0, "2026-11-05T00:00:00Z"),
    cycleOrder("second", "2026-11-03T00:00:00Z", 1),
  ]);
  assert.deepEqual(cycle.map((entry) => entry.id), ["first", "second"]);
});

test("an order with items still waiting keeps later orders with it", () => {
  const cycle = selectCurrentCycle([
    cycleOrder("first", "2026-11-01T00:00:00Z", 1),
    cycleOrder("second", "2026-11-03T00:00:00Z", 1),
  ]);
  assert.equal(cycle.length, 2);
});

test("unticking items shares the downpayment by value and keeps each discount", () => {
  const invoice = {
    items: [
      { id: "a", reservationId: "one", lineTotal: 500, unitPrice: 500, quantity: 1 },
      { id: "b", reservationId: "two", lineTotal: 1000, unitPrice: 1000, quantity: 1 },
    ],
    reservations: [
      { id: "one", remainingGross: 500, remainingDiscount: 0 },
      { id: "two", remainingGross: 1000, remainingDiscount: 100 },
    ],
    totals: {
      subtotal: 1500,
      discount: 100,
      total: 1400,
      quantity: 2,
      amountPaid: 700,
      downpayment: 1000,
      balance: 700,
    },
  };

  const selected = selectCustomerInvoiceItems(invoice, ["a"]);
  assert.equal(selected.totals.total, 500);
  assert.equal(selected.totals.amountPaid, 250);
  assert.equal(selected.totals.balance, 250);
});

test("the invoice shows only remaining figures and links each release PDF", async () => {
  const [preview, document] = await Promise.all([
    readFile(
      new URL("../components/reservations/customer-invoice-preview.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../lib/reservations/customer-invoice-document.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(preview, /label="Remaining downpayment"/);
  assert.match(preview, /"\/shipments\/" \+ release\.id \+ "\/pdf"/);
  assert.doesNotMatch(preview, /label="COD" value=\{displayInvoice/);
  assert.match(document, /"Remaining Downpayment"/);
  assert.doesNotMatch(document, /"Applied Downpayment"/);
});

test("releasing part of a quantity charges only that part", () => {
  const item = { id: "a", reservationId: "one", lineTotal: 3000, unitPrice: 1000, quantity: 3 };
  const invoice = {
    reservations: [{ id: "one", remainingGross: 3000, remainingDiscount: 300 }],
  };
  assert.equal(getReleaseValue(invoice, [{ item, quantity: 1 }]), 900);
  assert.equal(getReleaseValue(invoice, [{ item, quantity: 3 }]), 2700);

  const noDiscount = { reservations: [{ id: "one", remainingGross: 3000, remainingDiscount: 0 }] };
  const preview = computeReleasePreview({
    remainingTotal: 3000,
    unappliedDownpayment: 300,
    availableDownpayment: 300,
    releaseValue: getReleaseValue(noDiscount, [{ item, quantity: 1 }]),
    applied: 100,
  });
  assert.equal(preview.cod, 900);
  assert.equal(preview.remainingTotal, 2000);
  assert.equal(preview.remainingDownpayment, 200);
  assert.equal(preview.remainingBalance, 1800);
});

test("the release form shows what will remain after the deduction", () => {
  const preview = computeReleasePreview({
    remainingTotal: 3500,
    unappliedDownpayment: 1000,
    availableDownpayment: 1000,
    releaseValue: 2000,
    applied: 300,
  });
  assert.deepEqual(preview, {
    releaseValue: 2000,
    applied: 300,
    cod: 1700,
    remainingTotal: 1500,
    remainingDownpayment: 700,
    remainingBalance: 800,
  });
});

test("the preview matches the invoice after the same release", () => {
  const preview = computeReleasePreview({
    remainingTotal: 1500,
    unappliedDownpayment: 1000,
    availableDownpayment: 1000,
    releaseValue: 1000,
    applied: 200,
  });
  const invoice = computeCycleTotals([
    order({ remainingTotal: 500, releasedTotal: 1000, paid: 1000, appliedShipped: 200 }),
  ]);
  assert.equal(preview.remainingTotal, invoice.remainingTotal);
  assert.equal(preview.remainingDownpayment, invoice.availableDownpayment);
  assert.equal(preview.remainingBalance, invoice.remainingBalance);
  assert.equal(preview.cod, invoice.cod);
});

test("one typed amount fills the selected orders in turn", () => {
  assert.deepEqual(allocateAppliedDownpayment([1000, 2000], 1500), [1000, 500]);
  assert.deepEqual(allocateAppliedDownpayment([1000, 2000], 300), [300, 0]);
  assert.deepEqual(allocateAppliedDownpayment([1000, 2000], 0), [0, 0]);
});

test("an added downpayment is saved as its own payment on top of earlier ones", async () => {
  const [actions, form] = await Promise.all([
    readFile(new URL("../actions/reservations.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/reservations/reservation-form.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(actions, /rpc\("record_reservation_payment"/);
  assert.match(actions, /additionalCents > additionalRoomCents/);
  assert.match(form, /label="Add downpayment"/);
  assert.match(form, /name="additionalDownpayment"/);

  // In centavos: 300 fills the oldest order's room first.
  assert.deepEqual(allocateAppliedDownpayment([20000, 50000], 30000), [20000, 10000]);
});

test("a fully released customer still opens without order actions", async () => {
  const [loader, preview] = await Promise.all([
    readFile(new URL("../lib/reservations/customer-invoice.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../components/reservations/customer-invoice-preview.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(loader, /!documentItems\.length &&\s+!reservations\.some/);
  assert.match(preview, /All items have been released/);
  assert.match(
    preview,
    /delivered: invoice\.reservations\.filter\(\s+\(r\) =>\s+invoice\.items\.length > 0/,
  );
  assert.match(
    preview,
    /cancelled: invoice\.reservations\.filter\(\s+\(r\) =>\s+invoice\.items\.length > 0/,
  );
});

test("a release accepts 0 applied but rejects an invalid amount", () => {
  const release = {
    reservationId: "6f1c2b1e-3a55-4a45-9c1b-0d0a4f3e2b11",
    items: [{ reservationItemId: "7a2d3c2f-4b66-4b56-8d2c-1e1b5a4f3c22", quantity: 1 }],
    releaseDate: "2026-11-10",
  };
  assert.equal(
    releaseItemsSchema.safeParse({ ...release, downpaymentApplied: "0" }).success,
    true,
  );
  assert.equal(
    releaseItemsSchema.safeParse({ ...release, downpaymentApplied: "-5" }).success,
    false,
  );
});

test("a partly released order appears in both Delivered and Reserved", async () => {
  const page = await readFile(
    new URL("../app/(dashboard)/reservations/page.tsx", import.meta.url),
    "utf8",
  );
  const deliveredBranch = page.slice(
    page.indexOf("if (isDeliveredView) {"),
    page.indexOf('} else if (filters.status === "reserved")'),
  );
  assert.match(deliveredBranch, /query\.not\("delivered_at", "is", null\)/);
  assert.match(page, /isPartlyReleased\(reservation\.id\)/);
  assert.match(page, /resPaid = Math\.max\(resPaid - appliedDp, 0\)/);
});

test("the server limits a release to the customer's remaining downpayment", async () => {
  const actions = await readFile(
    new URL("../actions/shipments.ts", import.meta.url),
    "utf8",
  );
  assert.match(actions, /requestedDownpayment > customerInvoice\.availableDownpayment/);
});
