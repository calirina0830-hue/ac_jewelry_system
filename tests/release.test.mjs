import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  computeReleaseLedger,
  getReleaseDisplayStatus,
  releaseStatusLabel,
} from "../lib/reservations/release.ts";
import { buildShipmentDocDefinition } from "../lib/reservations/invoice-document.ts";
import {
  prepareReleaseSchema,
  releaseItemsSchema,
} from "../lib/validation/shipments.ts";

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

test("item release requires a positive downpayment", () => {
  const base = {
    reservationId,
    items: [{ reservationItemId: itemA, quantity: 1 }],
    releaseDate: "2026-10-18",
  };

  assert.equal(
    releaseItemsSchema.safeParse({ ...base, downpaymentApplied: "0" }).success,
    false,
  );
  assert.equal(
    releaseItemsSchema.safeParse({ ...base, downpaymentApplied: "500" }).success,
    true,
  );
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
    "Applied downpayment to released items",
    "All reserved items have been released",
  ]) {
    assert.equal(page.includes(fragment), true, fragment);
  }
});

test("only Reserved and Paid lists compile customers; release flows stay separate", async () => {
  const [page, documentData, actions, listPage] = await Promise.all([
    readFile(
      new URL("../app/(dashboard)/reservations/[id]/invoice/page.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../lib/reservations/invoice-data.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../actions/shipments.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/(dashboard)/reservations/page.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.equal(page.includes('eq("reservation_id", reservation.id)'), true);
  assert.equal(page.includes("siblingReservationIds"), false);
  assert.equal(documentData.includes('eq("reservation_id", reservation.id)'), true);
  assert.equal(documentData.includes("siblingReservationIds"), false);
  assert.equal(
    actions.includes(
      "itemRows.some((item) => item.reservation_id !== parsed.data.reservationId)",
    ),
    true,
  );
  assert.equal(
    listPage.includes('filters.status === "reserved" || filters.status === "paid"'),
    true,
  );
  assert.equal(listPage.includes("normalizeCustomerName"), false);
  assert.equal(
    listPage.includes('"customer:" + reservation.customer_id'),
    true,
  );
  assert.match(
    listPage,
    /\(filters\.status === "reserved" \|\| filters\.status === "paid"\)[\s\S]*remainingQty <= 0/,
  );
  assert.match(
    listPage,
    /filters\.status !== "paid" \|\|[\s\S]*itemsByReservation\.get\(reservation\.id\)/,
  );
});

test("payment-ledger reconciliation skips released and delivered reservations", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/202610300001_separate_downpayment_from_payments.sql",
      import.meta.url,
    ),
    "utf8",
  );

  const reconciliation = migration.split(
    "-- Bring existing balances/statuses in line with their recorded payments",
  )[1];
  assert.ok(reconciliation);
  assert.match(reconciliation, /reservation\.delivered_at is null/i);
  assert.match(
    reconciliation,
    /not exists \([\s\S]*public\.reservation_shipments[\s\S]*shipment\.status = 'shipped'/i,
  );
});

test("manual additions reuse one active reservation number per customer", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/202610230001_reuse_customer_reservation.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    migration,
    /status\s*=\s*'reserved'[\s\S]*archived_at\s+is\s+null/i,
  );
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(
    migration,
    /update\s+public\.reservation_items\s+set\s+reservation_id\s*=\s*v_existing_id/i,
  );
  assert.match(
    migration,
    /subtotal\s*=\s*existing\.subtotal\s*\+\s*v_created\.subtotal/i,
  );
  assert.match(
    migration,
    /insert\s+into\s+public\.reservation_payments/i,
  );
});

test("active customer reservations ignore item dates and retain the earliest row date", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/202611080001_merge_active_customer_reservations_regardless_of_date.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(migration, /status\s+in\s*\('reserved',\s*'paid'\)/i);
  assert.match(
    migration,
    /order\s+by\s+reservation\.reserved_at,\s*reservation\.created_at,\s*reservation\.id/i,
  );
  assert.match(migration, /reservation\.status\s*=\s*'delivered'/i);
  assert.match(migration, /reservation_item_committed_quantity/i);
  assert.match(migration, /ordered_at/i);
  assert.match(migration, /update\s+public\.reservation_items\s+set\s+reservation_id\s*=\s*v_existing_id/i);
  assert.match(migration, /reserved_at\s*=\s*least\(target\.reserved_at,\s*v_duplicate\.reserved_at\)/i);
  assert.match(migration, /archived_at\s+is\s+null/i);
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
    "Applied downpayment to released items",
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

test("release downpayment can become COD but cannot be zero", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/202611090001_release_downpayment_as_cod.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(migration, /p_allow_unfunded_downpayment/i);
  assert.match(migration, /downpayment_required/i);
  assert.match(migration, /p_downpayment_applied\s*<=\s*0/i);
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

test("reservation summary uses remaining items and active payment allocation", async () => {
  const page = await readFile(
    new URL("../app/(dashboard)/reservations/[id]/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(page, /calculatePaymentTransactionSummary/);
  assert.match(page, /paymentTransaction\.remainingItemsSubtotal/);
  assert.match(page, /paymentTransaction\.remainingReservationDiscount/);
  assert.match(page, /paymentTransaction\.remainingItemsTotal/);
  assert.match(page, /paymentTransaction\.remainingBalance/);
  assert.match(page, /Payment breakdown/);
  assert.match(
    page,
    /activePaymentTotal\s*-\s*usedDownpayment\s*-\s*reservedDownpayment/,
  );
});

test("reservation details keep downpayment separate from item rows", async () => {
  const page = await readFile(
    new URL("../app/(dashboard)/reservations/[id]/page.tsx", import.meta.url),
    "utf8",
  );

  for (const fragment of [
    "Payment and downpayment details",
    'label="Downpayment"',
    'label="Applied to releases"',
    'label="Open release hold"',
    'label="Available downpayment"',
  ]) {
    assert.equal(page.includes(fragment), true, fragment);
  }
  assert.equal(page.includes("allocateDownpaymentByLineTotal"), false);
  assert.equal(page.includes(">Downpayment</th>"), false);
});

test("reservation edit hides fully released items and shows downpayment details", async () => {
  const [page, form, types] = await Promise.all([
    readFile(
      new URL("../app/(dashboard)/reservations/[id]/edit/page.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../components/reservations/reservation-form.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../types/reservations.ts", import.meta.url), "utf8"),
  ]);

  for (const fragment of [
    "reservation_shipment_items",
    'shipment.status === "shipped"',
    "releasedByItem",
    "fullyReleasedItems",
    "preservedItems: fullyReleasedItems.map(toInitialItem)",
  ]) {
    assert.equal(page.includes(fragment), true, "edit page: " + fragment);
  }
  for (const fragment of [
    "fully released item",
    "name=\"downpayment\"",
    "Downpayment is separate from payment records",
    'label="Used downpayment"',
    "Remaining balance for downpayment",
  ]) {
    assert.equal(form.includes(fragment), true, "form: " + fragment);
  }
  assert.match(types, /preservedItems\?: ReservationInitialItem\[\]/);
});

test("reservation edits can change downpayment without changing payment records", async () => {
  const [form, actions, migration, errors] = await Promise.all([
    readFile(
      new URL("../components/reservations/reservation-form.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../actions/reservations.ts", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../supabase/migrations/202610300001_separate_downpayment_from_payments.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(new URL("../lib/reservations/errors.ts", import.meta.url), "utf8"),
  ]);

  assert.equal(form.includes('name="downpayment"'), true);
  assert.equal(form.includes("Downpayment is separate from payment records"), true);
  assert.equal(
    actions.includes('"update_reservation_with_payment_adjustment"'),
    true,
  );
  assert.match(migration, /public\.update_reservation\s*\(/i);
  assert.doesNotMatch(migration, /v_adjustment\s*:=/i);
  const editWrapper = migration
    .split("create or replace function public.update_reservation_with_payment_adjustment")[1]
    ?.split("$function$;")[0];
  assert.ok(editWrapper);
  assert.doesNotMatch(editWrapper, /insert into public\.reservation_payments/i);
  assert.match(migration, /downpayment_below_committed/i);
  assert.match(errors, /downpayment_below_committed/);
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
