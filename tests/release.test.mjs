import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  computeReleaseLedger,
  getReleaseDisplayStatus,
  releaseStatusLabel,
} from "../lib/reservations/release.ts";
import { buildShipmentDocDefinition } from "../lib/reservations/invoice-document.ts";
import { prepareReleaseSchema } from "../lib/validation/shipments.ts";

const reservationId = "11111111-1111-4111-8111-111111111111";
const itemA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("release selection accepts an optional downpayment amount", () => {
  const base = {
    reservationId,
    items: [{ reservationItemId: itemA, quantity: 1 }],
  };

  assert.equal(
    prepareReleaseSchema.safeParse({ ...base, downpaymentApplied: "500" }).success,
    true,
  );
  assert.equal(
    prepareReleaseSchema.safeParse({ ...base, downpaymentApplied: "0" }).success,
    true,
  );
  assert.equal(
    prepareReleaseSchema.safeParse({ ...base, downpaymentApplied: "" }).success,
    true,
  );
});

test("release selection rejects malformed downpayment amounts", () => {
  const base = {
    reservationId,
    items: [{ reservationItemId: itemA, quantity: 1 }],
  };

  for (const invalid of ["12.345", "abc", "-5", "10000000000"]) {
    assert.equal(
      prepareReleaseSchema.safeParse({ ...base, downpaymentApplied: invalid })
        .success,
      false,
      invalid,
    );
  }
});

test("release status derives Partially or Fully Released from released quantity", () => {
  assert.equal(getReleaseDisplayStatus(0, 3), null);
  assert.equal(getReleaseDisplayStatus(1, 3), "partially_released");
  assert.equal(getReleaseDisplayStatus(3, 3), "fully_released");
  assert.equal(getReleaseDisplayStatus(4, 3), "fully_released");
  assert.equal(getReleaseDisplayStatus(0, 0), null);

  assert.equal(releaseStatusLabel("fully_released"), "Fully Released");
  assert.equal(releaseStatusLabel("partially_released"), "Partially Released");
  assert.equal(releaseStatusLabel(null), null);
});

test("release ledger splits items into released and remaining portions", () => {
  const itemA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const itemB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const shipmentShipped = "11111111-1111-4111-8111-111111111111";
  const shipmentPending = "22222222-2222-4222-8222-222222222222";
  const shipmentCancelled = "33333333-3333-4333-8333-333333333333";

  const ledger = computeReleaseLedger(
    [
      {
        id: itemA,
        description: "A",
        quantity: 3,
        unitPrice: 1000,
        discount: 0,
      },
      {
        id: itemB,
        description: "B",
        quantity: 2,
        unitPrice: 500,
        discount: 100,
      },
    ],
    [
      { id: shipmentShipped, status: "shipped", downpayment_applied: 400 },
      { id: shipmentPending, status: "pending", downpayment_applied: 300 },
      { id: shipmentCancelled, status: "cancelled", downpayment_applied: 999 },
    ],
    [
      { shipment_id: shipmentShipped, reservation_item_id: itemA, quantity: 1 },
      { shipment_id: shipmentShipped, reservation_item_id: itemB, quantity: 1 },
      { shipment_id: shipmentPending, reservation_item_id: itemA, quantity: 1 },
      { shipment_id: shipmentCancelled, reservation_item_id: itemA, quantity: 3 },
    ],
  );

  const rowA = ledger.items.find((row) => row.id === itemA);
  const rowB = ledger.items.find((row) => row.id === itemB);

  assert.equal(rowA.releasedQty, 2);
  assert.equal(rowA.remainingQty, 1);
  assert.equal(rowA.releasedSubtotal, 2000);
  assert.equal(rowA.remainingSubtotal, 1000);

  assert.equal(rowB.releasedQty, 1);
  assert.equal(rowB.remainingQty, 1);
  assert.equal(rowB.releasedSubtotal, 450);
  assert.equal(rowB.remainingSubtotal, 450);

  assert.equal(ledger.releasedUnits, 3);
  assert.equal(ledger.remainingUnits, 2);
  assert.equal(ledger.releasedSubtotal, 2450);
  assert.equal(ledger.remainingSubtotal, 1450);
  assert.equal(ledger.downpaymentCommitted, 700);
});

test("invoice page fetches releases and shows only remaining items", async () => {
  const page = await readFile(
    new URL("../app/(dashboard)/reservations/[id]/invoice/page.tsx", import.meta.url),
    "utf8",
  );

  for (const fragment of [
    "computeReleaseLedger",
    "reservation_shipments",
    "reservation_shipment_items",
    "remainingQty",
    "remainingSubtotal",
    "downpaymentCommitted",
    "remainingUnapplied",
    "Already released",
    "Subtotal (remaining items)",
    "Applied to released goods",
    "All reserved items have been released",
  ]) {
    assert.equal(page.includes(fragment), true, fragment);
  }
});

test("invoice PDF data reflects releases and remaining balance", async () => {
  const [document, data] = await Promise.all([
    readFile(
      new URL("../lib/reservations/invoice-document.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../lib/reservations/invoice-data.ts", import.meta.url),
      "utf8",
    ),
  ]);

  for (const fragment of [
    "Already released",
    "Applied to released goods",
    "releasedQty",
    "remaining",
  ]) {
    assert.equal(document.includes(fragment), true, "document: " + fragment);
  }
  for (const fragment of [
    "computeReleaseLedger",
    "remainingSubtotal",
    "downpaymentCommitted",
    "reservation_shipments",
    "remainingUnapplied",
  ]) {
    assert.equal(data.includes(fragment), true, "data: " + fragment);
  }
});

test("release migration adds downpayment columns and the committed helper", async () => {
  const sql = await readFile(
    new URL(
      "../supabase/migrations/202610110002_item_release_downpayment.sql",
      import.meta.url,
    ),
    "utf8",
  );

  for (const fragment of [
    "add column downpayment_applied numeric(12, 2)",
    "add column downpayment_allocated numeric(12, 2)",
    "function public.reservation_downpayment_committed",
    "prepare_reservation_shipment(uuid, jsonb, numeric)",
    "insufficient_downpayment",
    "downpayment_exceeds_released_value",
    "downpayment_allocated",
    "create or replace function public.prepare_reservation_shipment",
    "information_schema.columns",
    "pg_constraint",
  ]) {
    assert.equal(sql.includes(fragment), true, fragment);
  }
});

test("reservation detail page displays release quantities and downpayment", async () => {
  const page = await readFile(
    new URL("../app/(dashboard)/reservations/[id]/page.tsx", import.meta.url),
    "utf8",
  );

  for (const fragment of [
    "ReleaseStatusBadge",
    "downpayment_applied",
    "Remaining unapplied",
    "Used on releases",
    "shippedByItem",
    "usedDownpayment",
    "reservedDownpayment",
    "discount",
    "displayedPaidAmount",
  ]) {
    assert.equal(page.includes(fragment), true, fragment);
  }
  for (const removed of ["Released / Held", "outstanding after release"]) {
    assert.equal(
      page.includes(removed),
      false,
      "detail page must not show release amounts: " + removed,
    );
  }
});

test("release panel shows an invoice preview restricted to released items", async () => {
  const panel = await readFile(
    new URL(
      "../components/reservations/shipping-panel.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  for (const fragment of [
    "Invoice preview",
    "Only the items below are invoiced for this release",
    "Released items subtotal",
    "Downpayment applied",
    "Balance on released goods",
    "Remaining unapplied downpayment after this release",
    "releasedValue",
    "previewLines",
    "getReleaseFinancialSummary",
    "release-invoice-modal-title",
    "generate invoice",
    "Remaining unapplied",
    "Reserved by open release",
    "release-invoice-generated-title",
    "Order date",
    "Unit price",
    "formatOrderDateTime",
    "shipped, ",
    "setItemQuantity",
    "Quantity to release",
    "Remove",
  ]) {
    assert.equal(panel.includes(fragment), true, fragment);
  }
});

test("release actions read actual payment and shipment records for finances", async () => {
  const actions = await readFile(
    new URL("../actions/shipments.ts", import.meta.url),
    "utf8",
  );

  for (const fragment of [
    "getReleaseFinancialSummary",
    "reservation_payments",
    "voided_at",
    "downpayment_applied",
    "reservation_shipments",
    "remainingUnapplied",
    "shipped",
    "pending",
  ]) {
    assert.equal(actions.includes(fragment), true, fragment);
  }
});

test("shipments index page lists releases and fixes the /shipments route", async () => {
  const page = await readFile(
    new URL("../app/(dashboard)/shipments/page.tsx", import.meta.url),
    "utf8",
  );

  for (const fragment of [
    "reservation_shipments",
    "shipment_no",
    "shipped_at",
    "downpayment_applied",
    "reservation_shipment_items",
    "/shipments/" ,
    "shipmentQuerySchema",
    "ZERO_UUID",
  ]) {
    assert.equal(page.includes(fragment), true, fragment);
  }
});

test("release PDF records the applied downpayment", () => {
  const document = buildShipmentDocDefinition({
    business: {
      name: "AC Pearls and Jewels",
      descriptor: "Fine jewelry",
      systemLabel: "Reservation System",
    },
    shipmentNo: "SHP-2026-000001",
    shipmentStatus: "pending",
    shipmentDate: "2026-10-11T00:00:00+08:00",
    shippedAt: null,
    reservationNo: "RES-2026-000001",
    customerName: "Rina Santos",
    facebookName: null,
    phone: null,
    address: null,
    notes: null,
    cancelReason: null,
    downpaymentApplied: 500,
    items: [
      { description: "SKU-1 - Ring - Gold", orderedAt: null, quantity: 1 },
    ],
    totalQuantity: 1,
    generatedAt: "2026-10-11T00:00:00+08:00",
  });

  const serialized = JSON.stringify(document.content);
  assert.equal(serialized.includes("Downpayment Applied"), true);
  assert.equal(serialized.includes("₱500.00"), true);
});

test("release PDF shows the released subtotal and the balance owed", () => {
  const document = buildShipmentDocDefinition({
    business: {
      name: "AC Pearls and Jewels",
      descriptor: "Fine jewelry",
      systemLabel: "Reservation System",
    },
    shipmentNo: "SHP-2026-000001",
    shipmentStatus: "shipped",
    shipmentDate: "2026-10-11T00:00:00+08:00",
    shippedAt: "2026-10-11T10:30:00+08:00",
    reservationNo: "RES-2026-000001",
    customerName: "Rina Santos",
    facebookName: null,
    phone: null,
    address: null,
    notes: null,
    cancelReason: null,
    downpaymentApplied: 500,
    items: [
      {
        description: "SKU-1 - Ring - Gold",
        orderedAt: null,
        quantity: 1,
        subtotal: 699,
      },
    ],
    totalQuantity: 1,
    generatedAt: "2026-10-11T00:00:00+08:00",
  });

  const serialized = JSON.stringify(document.content);
  assert.equal(serialized.includes("Subtotal"), true);
  assert.equal(serialized.includes("₱699.00"), true);
  assert.equal(serialized.includes("Downpayment Applied"), true);
  assert.equal(serialized.includes("₱500.00"), true);
  assert.equal(serialized.includes("BALANCE ON RELEASED GOODS"), true);
  assert.equal(serialized.includes("₱199.00"), true);
});