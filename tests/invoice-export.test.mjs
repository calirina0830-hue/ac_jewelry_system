import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createCsv,
  escapeCsvCell,
  protectSpreadsheetValue,
} from "../lib/export/csv.ts";
import {
  filterReservationExportRows,
  filterStockExportRows,
} from "../lib/export/filters.ts";
import {
  getInvoiceStatusLabel,
  getInvoiceTotals,
} from "../lib/reservations/invoice.ts";

const reservations = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    reservation_no: "RES-2026-000001",
    customer_name: "Rina Santos",
    customer_facebook_name: "RinaS",
    status: "paid",
    archived_at: null,
    live_batch: "AUG18-AM",
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    reservation_no: "RES-2026-000002",
    customer_name: "Dianna Lorraine",
    customer_facebook_name: "Dianna L",
    status: "reserved",
    archived_at: null,
    live_batch: "AUG18-PM",
  },
  {
    id: "33333333-3333-3333-3333-333333333333",
    reservation_no: "RES-2026-000003",
    customer_name: "Rina Cruz",
    customer_facebook_name: "RinaC",
    status: "cancelled",
    archived_at: "2026-08-18T00:00:00Z",
    live_batch: "AUG18-AM",
  },
];

test("invoice focuses on order details without exposing customer details", async () => {
  const page = await readFile(
    new URL(
      "../app/(dashboard)/reservations/[id]/invoice/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.equal(page.includes('label="Customer name"'), false);
  assert.equal(page.includes("Facebook / CS Name"), true);
  assert.equal(page.toLocaleLowerCase().includes("customer.email"), false);
  for (const column of [">No.<", ">Item<", ">Quantity<", ">Unit Price<", ">Amount<"]) {
    assert.equal(page.includes(column), true, column);
  }
  assert.equal(page.includes('">SKU<"'), false);
  assert.equal(page.includes(">Description<"), false);
  assert.equal(page.includes(">Category<"), false);
  assert.equal(page.includes("item.sku + \" - \" + item.item_name + \" - \" + item.category"), true);
  assert.equal(page.includes("item.quantity"), true);
  assert.equal(page.includes("item.line_total"), true);
  assert.match(page, /items\.map/);
  assert.equal(page.includes("+\" more\""), false);
  assert.equal(page.includes("Show less"), false);
  assert.equal(page.includes("Balance Due"), true);
  assert.equal(page.includes("Total Quantity"), true);
});

test("invoice totals use stored reservation values", () => {
  assert.deepEqual(
    getInvoiceTotals({
      subtotal: "2500.00",
      discount: "100.00",
      total: "2400.00",
      downpayment: "500.00",
      balance: "1900.00",
    }),
    {
      subtotal: 2500,
      reservationDiscount: 100,
      total: 2400,
      amountPaid: 500,
      balance: 1900,
    },
  );
});

test("invoice supports every reservation status", () => {
  assert.equal(getInvoiceStatusLabel("reserved"), "Reserved");
  assert.equal(getInvoiceStatusLabel("paid"), "Paid");
  assert.equal(getInvoiceStatusLabel("delivered"), "Delivered");
  assert.equal(getInvoiceStatusLabel("cancelled"), "Cancelled");
});

test("reservation export respects status filters", () => {
  const result = filterReservationExportRows(reservations, {
    q: "",
    status: "paid",
    archive: "active",
  });
  assert.deepEqual(result.map((row) => row.reservation_no), ["RES-2026-000001"]);
});

test("reservation export respects customer and reservation-number search", () => {
  const customerResult = filterReservationExportRows(reservations, {
    q: "Rina",
    status: "all",
    archive: "all",
  });
  const numberResult = filterReservationExportRows(reservations, {
    q: "000002",
    status: "all",
    archive: "all",
  });

  assert.equal(customerResult.length, 2);
  assert.deepEqual(numberResult.map((row) => row.customer_name), [
    "Dianna Lorraine",
  ]);
});

test("reservation export respects archive filters", () => {
  const result = filterReservationExportRows(reservations, {
    q: "",
    status: "all",
    archive: "archived",
  });
  assert.deepEqual(result.map((row) => row.reservation_no), ["RES-2026-000003"]);
});

test("reservation export respects Live Batch filters", () => {
  const result = filterReservationExportRows(reservations, {
    q: "",
    liveBatch: "AUG18-PM",
    status: "all",
    archive: "all",
  });
  assert.deepEqual(result.map((row) => row.reservation_no), ["RES-2026-000002"]);
});

test("reservation export matches item SKU and item name search", () => {
  const skuResult = filterReservationExportRows(reservations, {
    q: "RNG-001",
    status: "all",
    archive: "all",
    itemMatchIds: [reservations[1].id],
  });
  assert.deepEqual(skuResult.map((row) => row.reservation_no), [
    "RES-2026-000002",
  ]);

  const nameResult = filterReservationExportRows(
    reservations,
    {
      q: "gold ring",
      status: "all",
      archive: "all",
      itemMatchIds: [reservations[0].id, reservations[2].id],
    },
  );
  assert.deepEqual(nameResult.map((row) => row.reservation_no), [
    "RES-2026-000001",
    "RES-2026-000003",
  ]);
});

test("CSV handles Unicode, commas, quotes, and line breaks", () => {
  const csv = createCsv(
    ["Customer", "Notes"],
    [["José, Jr.", 'Said "mine"\nPaid']],
  );

  assert.equal(csv.startsWith("\uFEFF"), true);
  assert.equal(csv.includes('"José, Jr."'), true);
  assert.equal(csv.includes('"Said ""mine""\nPaid"'), true);
});

test("CSV protects every spreadsheet formula prefix", () => {
  for (const value of ["=1+1", "+SUM(A1:A2)", "-2+3", "@cmd", "  =hidden"]) {
    assert.equal(protectSpreadsheetValue(value).startsWith("'"), true);
    assert.equal(escapeCsvCell(value).startsWith('"\''), true);
  }
  assert.equal(protectSpreadsheetValue("Rina"), "Rina");
});

test("stock export respects search, category, and archive filters", () => {
  const stock = [
    {
      sku: "RNG-001",
      name: "Gold Ring",
      category: "Rings",
      is_active: true,
      archived_at: null,
    },
    {
      sku: "NCK-001",
      name: "Pearl Necklace",
      category: "Necklaces",
      is_active: true,
      archived_at: "2026-08-18T00:00:00Z",
    },
  ];

  assert.equal(
    filterStockExportRows(stock, {
      q: "gold",
      category: "Rings",
      status: "active",
    }).length,
    1,
  );
  assert.equal(
    filterStockExportRows(stock, {
      q: "",
      category: "all",
      status: "archived",
    })[0]?.sku,
    "NCK-001",
  );
});

test("export routes omit IDs, email, secrets, and stock quantity columns", async () => {
  const [reservationRoute, stockRoute] = await Promise.all([
    readFile(
      new URL(
        "../app/(dashboard)/reservations/export/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../app/(dashboard)/stock/export/route.ts", import.meta.url),
      "utf8",
    ),
  ]);

  assert.equal(reservationRoute.includes('"Customer Email"'), false);
  assert.equal(reservationRoute.includes('"Internal ID"'), false);
  assert.equal(stockRoute.includes('"Quantity"'), false);
  assert.equal(stockRoute.includes('"Jewelry Name"'), true);
  assert.equal(stockRoute.includes('authorizeRoles(["admin", "staff"])'), true);
});
