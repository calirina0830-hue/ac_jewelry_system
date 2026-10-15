import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildInvoiceDocDefinition,
  buildShipmentDocDefinition,
} from "../lib/reservations/invoice-document.ts";
import {
  cancelShipmentSchema,
  orderedAtSchema,
  prepareShipmentSchema,
} from "../lib/validation/shipments.ts";

const reservationId = "11111111-1111-4111-8111-111111111111";
const itemA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const itemB = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";

test("shipment selection accepts one or more valid items", () => {
  const result = prepareShipmentSchema.safeParse({
    reservationId,
    items: [
      { reservationItemId: itemA, quantity: 2 },
      { reservationItemId: itemB, quantity: 1 },
    ],
  });

  assert.equal(result.success, true);
});

test("shipment selection rejects empty, duplicate, and invalid quantities", () => {
  assert.equal(
    prepareShipmentSchema.safeParse({ reservationId, items: [] }).success,
    false,
  );
  assert.equal(
    prepareShipmentSchema.safeParse({
      reservationId,
      items: [
        { reservationItemId: itemA, quantity: 1 },
        { reservationItemId: itemA, quantity: 1 },
      ],
    }).success,
    false,
  );
  assert.equal(
    prepareShipmentSchema.safeParse({
      reservationId,
      items: [{ reservationItemId: itemA, quantity: 0 }],
    }).success,
    false,
  );
  assert.equal(
    prepareShipmentSchema.safeParse({
      reservationId,
      items: [{ reservationItemId: itemA, quantity: 1.5 }],
    }).success,
    false,
  );
});

test("shipment selection caps a single shipment at 200 items", () => {
  const items = Array.from({ length: 201 }, (_, index) => ({
    reservationItemId:
      String(index).padStart(8, "0") + "-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    quantity: 1,
  }));

  assert.equal(
    prepareShipmentSchema.safeParse({ reservationId, items }).success,
    false,
  );
  assert.equal(
    prepareShipmentSchema.safeParse({ reservationId, items: items.slice(0, 200) })
      .success,
    true,
  );
});

test("shipment cancellation limits the reason length", () => {
  const base = { reservationId, shipmentId: itemA };
  assert.equal(cancelShipmentSchema.safeParse(base).success, true);
  assert.equal(
    cancelShipmentSchema.safeParse({ ...base, reason: "Customer changed mind" })
      .success,
    true,
  );
  assert.equal(
    cancelShipmentSchema.safeParse({ ...base, reason: "x".repeat(1001) }).success,
    false,
  );
});

test("order date corrections require an offset timestamp", () => {
  const base = { reservationId, reservationItemId: itemA };
  assert.equal(
    orderedAtSchema.safeParse({ ...base, orderedAt: "2026-08-18T10:30:00+08:00" })
      .success,
    true,
  );
  assert.equal(
    orderedAtSchema.safeParse({ ...base, orderedAt: "not-a-date" }).success,
    false,
  );
});

test("shipping migration adds order dates, shipment tables, and RPCs", async () => {
  const sql = await readFile(
    new URL(
      "../supabase/migrations/202610110001_master_invoice_shipping.sql",
      import.meta.url,
    ),
    "utf8",
  );

  for (const fragment of [
    "add column ordered_at timestamptz",
    "create table public.reservation_shipments",
    "create table public.reservation_shipment_items",
    "function public.next_shipment_number",
    "function public.reservation_item_committed_quantity",
    "function public.prepare_reservation_shipment",
    "function public.confirm_reservation_shipment",
    "function public.cancel_reservation_shipment",
    "function public.set_reservation_item_ordered_at",
    "reservation_item_has_shipments",
    "reservation_item_below_committed",
  ]) {
    assert.equal(sql.includes(fragment), true, fragment);
  }
});

test("invoice page exposes order dates and a PDF download", async () => {
  const page = await readFile(
    new URL(
      "../app/(dashboard)/reservations/[id]/invoice/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.equal(page.includes("Order Date"), true);
  assert.equal(page.includes("ordered_at"), true);
  assert.equal(page.includes("/invoice/pdf"), true);
});

test("reservation detail page wires shipments and order-date editing", async () => {
  const page = await readFile(
    new URL("../app/(dashboard)/reservations/[id]/page.tsx", import.meta.url),
    "utf8",
  );

  assert.equal(page.includes("ShippingPanel"), true);
  assert.equal(page.includes("OrderDateEditor"), true);
  assert.equal(page.includes("reservation_shipments"), true);
  assert.equal(page.includes("reservation_shipment_items"), true);
});

test("invoice document renders every item without dropping order dates", () => {
  const items = Array.from({ length: 120 }, (_, index) => ({
    description: "SKU-" + index + " - Ring - Gold",
    orderedAt: null,
    quantity: 1,
    unitPrice: 100,
    lineTotal: 100,
  }));
  const document = buildInvoiceDocDefinition({
    business: {
      name: "AC Pearls and Jewels",
      descriptor: "Fine jewelry",
      systemLabel: "Reservation System",
    },
    invoiceNo: "RES-2026-000001",
    invoiceDate: "2026-08-18T00:00:00+08:00",
    statusLabel: "Paid",
    delivered: false,
    customerName: "Rina Santos",
    facebookName: "RinaS",
    phone: null,
    address: null,
    notes: null,
    items,
    totals: {
      subtotal: 12000,
      reservationDiscount: 0,
      total: 12000,
      amountPaid: 6000,
      downpayment: 3000,
      remainingDownpayment: 3000,
      balance: 6000,
    },
    totalQuantity: 120,
    generatedAt: "2026-10-11T00:00:00+08:00",
  });

  const table = document.content.find((node) => "table" in node);
  assert.equal(table.table.headerRows, 1);
  assert.equal(table.table.body.length, 121);
  assert.equal(table.table.body[1][2].text, "Date not recorded");

  const footer = document.footer(2, 5);
  assert.equal(footer.columns[1].text, "Page 2 of 5");
});

test("shipment document records the shipment number and quantities", () => {
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
    items: [
      { description: "SKU-1 - Ring - Gold", orderedAt: null, quantity: 2 },
    ],
    totalQuantity: 2,
    generatedAt: "2026-10-11T00:00:00+08:00",
  });

  const table = document.content.find((node) => "table" in node);
  assert.equal(table.table.body.length, 2);
  assert.equal(table.table.body[1][3].text, "2");
});
