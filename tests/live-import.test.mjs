import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ExcelJS from "exceljs";

import {
  LIVE_IMPORT_HEADERS,
  buildLiveOrderPreview,
  normalizeLiveIdentity,
  parseCsv,
  parseLiveMoney,
  parseLiveOrderBuffer,
  resolveImportQuantity,
  toConfirmationRows,
} from "../lib/import/live-orders.ts";

const headers = LIVE_IMPORT_HEADERS.join(",") + "\r\n";
const stock = [
  { id: "stock-ring", sku: "R001", name: "Gold Ring", price: 1500 },
  { id: "stock-necklace", sku: "N002", name: "Pearl Necklace", price: 2000 },
];
const customers = [
  {
    id: "customer-rina",
    name: "Rina",
    facebook_name: "RinaS",
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "customer-cali",
    name: "Cali",
    facebook_name: "CALI",
    created_at: "2026-01-02T00:00:00Z",
  },
];

function row(overrides = {}) {
  return {
    rowNumber: 2,
    facebookName: "RinaS",
    itemCode: "R001",
    itemName: "",
    quantity: "",
    price: "",
    downpayment: "",
    ...overrides,
  };
}

function preview(rows, options = {}) {
  return buildLiveOrderPreview({
    parsed: { fileName: "orders.csv", fileHash: "a".repeat(64), rows },
    customers: options.customers ?? customers,
    stockItems: options.stockItems ?? stock,
  });
}

test("CSV parser safely handles quoted commas, quotes, and line breaks", () => {
  assert.deepEqual(parseCsv('Name,Value\r\n"Rina, S.","Said ""mine""\nagain"'), [
    ["Name", "Value"],
    ["Rina, S.", 'Said "mine"\nagain'],
  ]);
});

test("downloaded CSV template contains exactly the six seller-facing columns with no Date", async () => {
  assert.deepEqual([...LIVE_IMPORT_HEADERS], [
    "FB Name", "Item Code", "Item Name", "Quantity", "Price", "Downpayment",
  ]);
  assert.equal(LIVE_IMPORT_HEADERS.includes("Date"), false);
  const result = await parseLiveOrderBuffer(
    Buffer.from(headers + "RinaS,R001,Gold Ring,3,1500.00,500"),
    "orders.csv",
  );
  assert.deepEqual(result.rows[0], row({
    itemName: "Gold Ring",
    quantity: "3",
    price: "1500.00",
    downpayment: "500",
  }));
});

test("valid six-column XLSX parses the first worksheet without a Date column", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Live Orders");
  sheet.addRow([...LIVE_IMPORT_HEADERS]);
  sheet.addRow(["RinaS", "R001", "Gold Ring", "2", "1500.00", "500"]);
  const output = await workbook.xlsx.writeBuffer();
  const result = await parseLiveOrderBuffer(Buffer.from(output), "orders.xlsx");
  assert.equal(result.rows[0].itemCode, "R001");
  assert.equal(result.rows[0].itemName, "Gold Ring");
  assert.equal(result.rows[0].quantity, "2");
  assert.equal(result.rows[0].price, "1500.00");
  assert.equal(result.rows[0].downpayment, "500");
});

test("missing required headers and legacy templates are rejected clearly", async () => {
  await assert.rejects(
    parseLiveOrderBuffer(Buffer.from("Name,Code\nRina,R001"), "bad.csv"),
    /Missing required headers/,
  );
  for (const removedHeader of [
    "Customer Name",
    "FB / CS Name",
    "Live Batch",
    "Discount",
    "Notes",
  ]) {
    await assert.rejects(
      parseLiveOrderBuffer(
        Buffer.from(headers.trimEnd() + "," + removedHeader + "\nRinaS,R001,,,),,,value"),
        "old.csv",
      ),
      /This template is outdated\. Download the latest Live Selling template and try again\./,
    );
  }
});

test("normalized identity ignores case, surrounding spaces, and repeated spaces", () => {
  for (const spelling of ["CALI", "cali", "Cali", " CALI ", "CALI ", " CaLi  "]) {
    assert.equal(normalizeLiveIdentity(spelling), "cali");
  }
});

test("1. CALI and cali are treated as the same existing customer", () => {
  const result = preview([
    row({ facebookName: "CALI" }),
    row({ rowNumber: 3, facebookName: "cali", itemCode: "N002" }),
  ]);
  assert.equal(result.summary.reservationsToCreate, 1);
  assert.equal(result.summary.existingCustomers, 1);
  assert.equal(result.summary.newCustomers, 0);
  for (const previewRow of result.rows) {
    assert.equal(previewRow.customerMatch, "Matched");
    assert.equal(previewRow.valid, true);
  }
});

test("2. ' CALI ' matches the stored CALI customer", () => {
  const result = preview([row({ facebookName: " CALI " })]);
  assert.equal(result.rows[0].customerMatch, "Matched");
  assert.equal(result.rows[0].result, "Ready");
  assert.equal(result.rows[0].valid, true);
});

test("3. an existing matching customer is reused, never duplicated", () => {
  const result = preview([row({ facebookName: "rinas" })]);
  assert.equal(result.rows[0].existingCustomer, true);
  assert.equal(result.rows[0].customerMatch, "Matched");
  assert.equal(result.summary.existingCustomers, 1);
  assert.equal(result.summary.newCustomers, 0);
  const confirmation = toConfirmationRows(result)[0];
  assert.equal(confirmation.facebookName, "rinas");
});

test("4. multiple case-equivalent customer records never block the import", () => {
  // Two stored records whose FB names only differ by case/spacing both match
  // one normalized identity; the import reuses one deterministically instead
  // of rejecting the row as ambiguous.
  const result = preview([row({ facebookName: "CaLi" })], {
    customers: [
      { id: "c-older", name: "Cali A", facebook_name: "CALI", created_at: "2026-01-01T00:00:00Z" },
      { id: "c-newer", name: "Cali B", facebook_name: " cali ", created_at: "2026-02-01T00:00:00Z" },
    ],
  });
  assert.equal(result.rows[0].result, "Ready");
  assert.equal(result.rows[0].valid, true);
  assert.equal(result.rows[0].customerMatch, "Matched");
  assert.equal(result.rows[0].existingCustomer, true);
  assert.equal("Customer Ambiguous" in {}, false);
});

test("5. a missing customer is automatically created as New Customer", () => {
  const result = preview([row({ facebookName: "Brand New Buyer" })]);
  assert.equal(result.rows[0].customerMatch, "New Customer");
  assert.equal(result.rows[0].result, "New Customer");
  assert.equal(result.rows[0].valid, true);
  assert.equal(result.summary.newCustomers, 1);
});

test("6. same customer + item + price rows merge quantity (1+2+3 -> 6)", () => {
  const result = preview([
    row({ facebookName: "CALI", itemCode: "MSN", quantity: "1", price: "2,100", rowNumber: 2 }),
    row({ facebookName: "cali", itemCode: "msn", quantity: "2", price: "2100.00", rowNumber: 3 }),
    row({ facebookName: "Cali", itemCode: "MSN", quantity: "3", price: "₱2,100", rowNumber: 4 }),
  ], {
    stockItems: [{ id: "stock-msn", sku: "MSN", name: "Moissanite", price: 9999 }],
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].mergedQuantity, 6);
  assert.equal(result.rows[0].mergedFromRows, 3);
  assert.equal(result.rows[0].unitPrice, 2100);
  assert.equal(result.rows[0].valid, true);
  assert.equal(result.summary.itemsToCreate, 6);
  const sent = toConfirmationRows(result)[0];
  assert.equal(sent.quantity, 6);
  assert.equal(sent.price, "2100");
  assert.equal(Number(sent.price) * sent.quantity, 12600);
});

test("7. case-different customer names still merge into one reservation item", () => {
  const result = preview([
    row({ facebookName: "RINAS", quantity: "2" }),
    row({ rowNumber: 3, facebookName: "rinas", quantity: "3" }),
  ]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].mergedQuantity, 5);
  assert.equal(result.summary.reservationsToCreate, 1);
});

test("8. blank quantity defaults to one inside merged confirmation rows", () => {
  const result = preview([
    row(),
    row({ rowNumber: 3, quantity: "2" }),
  ]);
  const sent = toConfirmationRows(result);
  assert.deepEqual(sent.map((sentRow) => sentRow.quantity), [3]);
});

test("9. 2100 / 2,100 / ₱2,100 all normalize to the same numeric price", () => {
  assert.equal(parseLiveMoney("2100"), "2100");
  assert.equal(parseLiveMoney("2100.00"), "2100.00");
  assert.equal(parseLiveMoney("2,100"), "2100");
  assert.equal(parseLiveMoney('"'), null);
  assert.equal(parseLiveMoney("2,100.00"), "2100.00");
  assert.equal(parseLiveMoney(" 2,100 "), "2100");
  assert.equal(parseLiveMoney("₱2100"), "2100");
  assert.equal(parseLiveMoney("₱2,100"), "2100");
  assert.equal(parseLiveMoney("₱ 2,100.00"), "2100.00");
  // All four spellings land on ONE merge line.
  const result = preview([
    row({ price: "2100", rowNumber: 2 }),
    row({ rowNumber: 3, price: "2,100" }),
    row({ rowNumber: 4, price: "₱2,100" }),
    row({ rowNumber: 5, price: "2100.00" }),
  ]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].mergedQuantity, 4);
});

test("10. same customer + item at different prices stay separate lines", () => {
  const result = preview([
    row({ facebookName: "CALI", itemCode: "MSN", price: "1,900", rowNumber: 2 }),
    row({ rowNumber: 3, facebookName: "CALI", itemCode: "MSN", price: "2,100" }),
  ], {
    stockItems: [{ id: "stock-msn", sku: "MSN", name: "Moissanite", price: 9999 }],
  });
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map((previewRow) => previewRow.unitPrice), [1900, 2100]);
  assert.deepEqual(result.rows.map((previewRow) => previewRow.mergedQuantity), [1, 1]);
  for (const previewRow of result.rows) {
    assert.equal(previewRow.valid, true);
  }
  assert.equal(toConfirmationRows(result).length, 2);
});

test("11. blank, zero, and decimal-zero downpayments import without a payment", () => {
  const result = preview([
    row(),
    row({ rowNumber: 3, itemCode: "N002", downpayment: "0" }),
    row({ rowNumber: 4, itemCode: "N002", downpayment: "0.00" }),
  ]);
  for (const previewRow of result.rows) {
    assert.equal(previewRow.valid, true);
  }
  assert.equal(toConfirmationRows(result)[0].downpayment, "");
});

test("invalid money text like 'abc' or negatives is still rejected per column", () => {
  assert.equal(parseLiveMoney("abc"), null);
  assert.equal(parseLiveMoney("-5"), null);
  const priced = preview([
    row({ price: "-5" }),
    row({ rowNumber: 3, itemCode: "N002", downpayment: "abc" }),
  ]);
  assert.equal(priced.rows[0].result, "Invalid Price");
  assert.equal(priced.rows[1].result, "Invalid Downpayment");
  assert.equal(priced.summary.invalidRows, 2);
});

test("quantity stays a positive whole number; blank means one", () => {
  assert.equal(resolveImportQuantity(""), 1);
  assert.equal(resolveImportQuantity("   "), 1);
  assert.equal(resolveImportQuantity("1"), 1);
  assert.equal(resolveImportQuantity("10"), 10);
  assert.equal(resolveImportQuantity("03"), 3);
  assert.equal(resolveImportQuantity("0"), null);
  assert.equal(resolveImportQuantity("-1"), null);
  assert.equal(resolveImportQuantity("1.5"), null);
  assert.equal(resolveImportQuantity("abc"), null);

  const quantities = preview([
    row({ quantity: "0" }),
    row({ rowNumber: 3, itemCode: "N002", quantity: "-1" }),
  ]);
  assert.equal(quantities.rows[0].result, "Invalid Quantity");
  assert.equal(quantities.rows[1].result, "Invalid Quantity");
});

test("12. Item Name capitalization differences never reject a row", () => {
  const result = preview([row({ itemCode: "MSO", itemName: "Moissanite" })], {
    stockItems: [{ id: "stock-mso", sku: "MSO", name: "MOISSANITE", price: 2100 }],
  });
  assert.equal(result.rows[0].valid, true);
  assert.equal(result.rows[0].itemMatch, "Matched");
  // The trusted Stock name wins for the saved snapshot.
  assert.equal(result.rows[0].catalogItemName, "MOISSANITE");
});

test("13. Item Not Found remains rejected", () => {
  const result = preview([row({ itemCode: "missing" })]);
  assert.equal(result.rows[0].result, "Item Not Found");
  assert.equal(result.rows[0].valid, false);
});

test("Item Code matching stays flexible: trimmed, case-insensitive, zero-tolerant", () => {
  assert.equal(preview([row({ itemCode: " r001 " })]).rows[0].valid, true);
  assert.equal(preview([row({ itemCode: "R001" })]).rows[0].valid, true);
  const leadingZero = preview([row({ itemCode: "1879" })], {
    stockItems: [{ id: "stock-ledger", sku: "001879", name: "Pearl Set", price: 900 }],
  });
  assert.equal(leadingZero.rows[0].valid, true);
  assert.equal(leadingZero.rows[0].catalogItemName, "Pearl Set");
  const ambiguousNumeric = preview([row({ itemCode: "123" })], {
    stockItems: [
      { id: "stock-first", sku: "00123", name: "First", price: 900 },
      { id: "stock-second", sku: "000123", name: "Second", price: 900 },
    ],
  });
  assert.equal(ambiguousNumeric.rows[0].result, "Item Ambiguous");
  assert.equal(ambiguousNumeric.rows[0].valid, false);
});

test("14. preview and confirmation use identical grouping and merged quantities", () => {
  const parsedRows = [
    row({ facebookName: "CALI", itemCode: "MSN", quantity: "1", price: "2,100", rowNumber: 2 }),
    row({ facebookName: "cali", itemCode: "MSN", quantity: "2", price: "₱2,100", rowNumber: 3 }),
    row({ facebookName: "Cali", itemCode: "MSN", quantity: "1", price: "1,900", rowNumber: 4 }),
    row({ rowNumber: 5, facebookName: "CALI", itemCode: "N002", downpayment: "300" }),
  ];
  const result = preview(parsedRows, {
    stockItems: [
      { id: "stock-msn", sku: "MSN", name: "Moissanite", price: 9999 },
      ...stock,
    ],
  });
  const sent = toConfirmationRows(result);
  assert.equal(sent.length, result.rows.length);
  assert.deepEqual(
    sent.map((sentRow) => sentRow.quantity),
    result.rows.map((previewRow) => previewRow.mergedQuantity),
  );
  // Merged line (rows 2+3), separate 1900 line, separate N002 line.
  assert.deepEqual(sent.map((sentRow) => sentRow.quantity), [3, 1, 1]);
  assert.equal(result.summary.reservationsToCreate, 1);
  assert.equal(result.summary.itemsToCreate, 5);
});

test("merged downpayments sum across physical rows and never multiply", () => {
  const result = preview([
    row({ rowNumber: 2, downpayment: "100" }),
    row({ rowNumber: 3, downpayment: "100" }),
    row({ rowNumber: 4, itemCode: "N002", downpayment: "50" }),
  ]);
  assert.equal(result.rows.length, 2);
  assert.equal(toConfirmationRows(result)[0].downpayment, "200.00");
  assert.equal(toConfirmationRows(result)[1].downpayment, "50");
});

test("blank selling prices fall back to the trusted catalog price for merging", () => {
  const result = preview([
    row({ price: "", rowNumber: 2 }),
    row({ rowNumber: 3, price: "" }),
  ]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].unitPrice, 1500);
  assert.equal(result.rows[0].mergedQuantity, 2);
});

test("same item + price for different customers create separate reservations", () => {
  const result = preview([
    row({ rowNumber: 2 }),
    row({ rowNumber: 3, facebookName: "New Miner" }),
  ]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.summary.reservationsToCreate, 2);
  assert.equal(result.summary.newCustomers, 1);
});

test("a new customer is created only once despite repeated rows", () => {
  const result = preview([
    row({ rowNumber: 2, facebookName: "New Miner" }),
    row({ rowNumber: 3, facebookName: "new miner" }),
    row({ rowNumber: 4, facebookName: "NEW MINER ", itemCode: "N002" }),
  ]);
  assert.equal(result.summary.newCustomers, 1);
  assert.equal(result.summary.reservationsToCreate, 1);
  assert.equal(result.summary.itemsToCreate, 3);
});

test("an empty FB Name is the only customer-side rejection left", () => {
  const result = preview([row({ facebookName: "   " })]);
  assert.equal(result.rows[0].result, "Invalid Customer");
  assert.equal(result.rows[0].valid, false);
});

test("preview results never surface Customer Ambiguous or duplicate warnings", () => {
  const result = preview(
    [row(), row({ rowNumber: 3 }), row({ rowNumber: 4 })],
    {
      customers: [
        ...customers,
        { id: "c-2", name: "Other", facebook_name: " rinas ", created_at: "2026-02-02T00:00:00Z" },
      ],
    },
  );
  const seenResults = new Set(result.rows.map((previewRow) => previewRow.result));
  assert.equal(seenResults.has("Customer Ambiguous"), false);
  assert.equal(seenResults.has("Duplicate Import"), false);
  assert.equal(seenResults.has("Duplicate Reserved Item"), false);
  assert.equal(seenResults.has("Ready"), true);
  assert.equal(result.summary.invalidRows, 0);
});

test("confirmation RPC mirrors preview normalization and reuse rules", async () => {
  const migration = await readFile(
    new URL("../supabase/migrations/202608220001_live_import_flexible_money.sql", import.meta.url),
    "utf8",
  );
  // Rows group by the SAME normalized identity used by the preview.
  assert.match(migration, /normalize_live_identity\(row\.value ->> 'facebookName'\)/);
  // Multiple case-equivalent records reuse the OLDEST active record.
  assert.match(
    migration,
    /order by customer\.created_at asc nulls last, customer\.id/,
  );
  // Zero matches auto-create the customer from the imported FB Name.
  assert.match(migration, /if v_customer_matches = 0 then/);
  assert.match(migration, /insert into public\.customers \(/);
  // Flexible money normalization lives in the RPC too ("2,100" -> 2100).
  // The SQL pattern text itself contains backslashes (\d, \.), so match it
  // literally with String.raw instead of a doubly-escaped regex.
  assert.ok(
    migration.includes(
      String.raw`if v_money_text !~ '^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$' then`,
    ),
    "price normalization pattern missing from confirm_live_order_import",
  );
  assert.ok(
    migration.includes(String.raw`replace(v_money_text, ',', '')::numeric`),
    "comma thousands separators must be stripped before casting to numeric",
  );
  // Same stock item + unit price merges quantity onto ONE line; the key
  // includes the price so different prices keep separate snapshot lines.
  assert.match(migration, /v_item_price_key := v_stock_id::text \|\| '\|' \|\| v_unit_price::text/);
  assert.match(migration, /quantity = quantity \+ v_quantity/);
  assert.match(migration, /line_total = unit_price \* \(quantity \+ v_quantity\)/);
  // Customer Ambiguous no longer exists anywhere in the confirmation path.
  assert.doesNotMatch(migration, /customer_ambiguous/i);
  // Downpayment stays optional and pays through the authoritative ledger.
  assert.match(migration, /if v_group_downpayment > 0 then/);
  assert.match(migration, /record_reservation_payment\(/);
});
