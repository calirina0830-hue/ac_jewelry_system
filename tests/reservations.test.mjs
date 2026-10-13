import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { mapReservationDatabaseError } from "../lib/reservations/errors.ts";
import {
  calculateReservationTotals,
  centsToDecimal,
  parseMoneyToCents,
} from "../lib/reservations/money.ts";
import {
  createReservationSchema,
  updateReservationSchema,
} from "../lib/validation/reservations.ts";

const customerId = "11111111-1111-4111-8111-111111111111";
const stockItemId = "22222222-2222-4222-8222-222222222222";
const secondStockItemId = "33333333-3333-4333-8333-333333333333";

test("reservation validation accepts multiple items", () => {
  const result = createReservationSchema.parse({
    customerId,
    reservationDiscount: "100.00",
    downpayment: "500.00",
    notes: "  Pick up on Saturday.  ",
    items: [
      { stockItemId, quantity: "3", sellingPrice: "1999.50", discount: "25.50" },
      { stockItemId: secondStockItemId, quantity: "1", sellingPrice: "750", discount: "0" },
    ],
  });

  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].discount, 2550);
  assert.equal(result.items[0].sellingPrice, 199950);
  assert.equal(result.items[0].quantity, 3);
  assert.equal(result.reservationDiscount, 10000);
  assert.equal(result.notes, "Pick up on Saturday.");
});

test("blank optional values normalize safely", () => {
  const result = createReservationSchema.parse({
    customerId,
    reservationDiscount: "",
    downpayment: undefined,
    notes: "   ",
    items: [{ stockItemId, quantity: "1", sellingPrice: "0", discount: "" }],
  });

  assert.equal(result.reservationDiscount, 0);
  assert.equal(result.downpayment, 0);
  assert.equal(result.notes, null);
  assert.equal(result.items[0].discount, 0);
});

test("reservation validation allows multiple lines with the same stock item", () => {
  const result = createReservationSchema.safeParse({
    customerId,
    items: [
      { stockItemId, quantity: "1", sellingPrice: "300", discount: "0" },
      { stockItemId, quantity: "1", sellingPrice: "200", discount: "0" },
    ],
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.items.length, 2);
    assert.equal(result.data.items[0].stockItemId, stockItemId);
    assert.equal(result.data.items[0].sellingPrice, 30000);
    assert.equal(result.data.items[1].stockItemId, stockItemId);
    assert.equal(result.data.items[1].sellingPrice, 20000);
  }
});

test("reservation validation rejects invalid seller-entered money", () => {
  const result = createReservationSchema.safeParse({
    customerId,
    reservationDiscount: "-1",
    items: [{ stockItemId, quantity: "1", sellingPrice: "", discount: "12.345" }],
  });

  assert.equal(result.success, false);
  assert.equal(result.error.issues.some((issue) => issue.path.at(-1) === "sellingPrice"), true);
  assert.equal(result.error.issues.some((issue) => issue.path.at(-1) === "discount"), true);
  assert.equal(result.error.issues.some((issue) => issue.path[0] === "reservationDiscount"), true);
});

test("money parsing and formatting use integer cents", () => {
  assert.equal(parseMoneyToCents("0.10"), 10);
  assert.equal(parseMoneyToCents("123456.78"), 12_345_678);
  assert.equal(centsToDecimal(12_345_678), "123456.78");
  assert.equal(centsToDecimal(-500_00), "-500.00");
  assert.equal(centsToDecimal(-750), "-7.50");
  assert.equal(parseMoneyToCents("1.999"), null);
});

test("reservation total calculation is exact in cents", () => {
  const totals = calculateReservationTotals(
    [
      { unitPriceCents: 199_999, quantity: 2, discountCents: 5_050 },
      { unitPriceCents: 75_025, quantity: 1, discountCents: 25 },
    ],
    10_000,
    50_000,
  );

  assert.deepEqual(totals.lines, [
    { lineSubtotalCents: 399_998, lineTotalCents: 394_948 },
    { lineSubtotalCents: 75_025, lineTotalCents: 75_000 },
  ]);
  assert.equal(totals.subtotalCents, 469_948);
  assert.equal(totals.totalCents, 459_948);
  assert.equal(totals.balanceCents, 409_948);
});

test("edit validation accepts Supabase offset timestamps", () => {
  const result = updateReservationSchema.safeParse({
    id: "44444444-4444-4444-8444-444444444444",
    updatedAt: "2026-08-17T15:00:00.123+00:00",
    customerId,
    items: [{ stockItemId, quantity: "4", sellingPrice: "899", discount: "0" }],
  });

  assert.equal(result.success, true);
});

test("seller-entered reservation quantity is validated and retained", () => {
  const result = createReservationSchema.parse({
    customerId,
    items: [{ stockItemId, quantity: "3", sellingPrice: "899", discount: "100" }],
  });
  assert.equal(result.items[0].quantity, 3);
});

test("reservation quantity rejects zero and decimal values", () => {
  for (const quantity of ["0", "1.5"]) {
    const result = createReservationSchema.safeParse({
      customerId,
      items: [{ stockItemId, quantity, sellingPrice: "899", discount: "0" }],
    });
    assert.equal(result.success, false);
    assert.equal(result.error.issues.some((issue) => issue.path.at(-1) === "quantity"), true);
  }
});

test("discount cannot exceed selling price times reservation quantity", () => {
  const valid = createReservationSchema.safeParse({
    customerId,
    items: [{ stockItemId, quantity: "3", sellingPrice: "100", discount: "299" }],
  });
  const invalid = createReservationSchema.safeParse({
    customerId,
    items: [{ stockItemId, quantity: "3", sellingPrice: "100", discount: "301" }],
  });
  assert.equal(valid.success, true);
  assert.equal(invalid.success, false);
});

test("server forwards validated reservation quantity to the trusted RPC", async () => {
  const action = await readFile(
    new URL("../actions/reservations.ts", import.meta.url),
    "utf8",
  );
  assert.match(action, /quantity: item\.quantity,[\s\S]*?selling_price/);
  assert.doesNotMatch(action, /existingQuantities/);
});

test("stale database edits map to a clear concurrency error", () => {
  assert.deepEqual(mapReservationDatabaseError("stale_reservation"), {
    message:
      "This reservation was changed in another session. Reload before saving again.",
  });
});

test("update RPC compares the submitted version while holding the row lock", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/202608170003_create_reservations.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(migration, /where reservation\.id = p_reservation_id\s+for update/i);
  assert.match(
    migration,
    /updated_at is distinct from p_expected_updated_at/i,
  );
  assert.match(migration, /raise exception 'stale_reservation'/i);
});

test("reservation numbers use a database sequence rather than row counts", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/202608170003_create_reservations.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(migration, /create sequence public\.reservation_number_seq/i);
  assert.match(migration, /nextval\('public\.reservation_number_seq'\)/i);
  assert.doesNotMatch(migration, /count\s*\(\s*\*\s*\)\s*\+\s*1/i);
});

test("normalizeCustomerName handles trimming, multiple spaces, and case normalization", async () => {
  const { normalizeCustomerName } = await import("../lib/format.ts");
  assert.equal(normalizeCustomerName("  Maria  Santos "), "maria santos");
  assert.equal(normalizeCustomerName("MARIA   SANTOS"), "maria santos");
  assert.equal(normalizeCustomerName("maria santos"), "maria santos");
  assert.equal(normalizeCustomerName("Maria Santos"), "maria santos");
  assert.equal(normalizeCustomerName(""), "");
  assert.equal(normalizeCustomerName(null), "");
  assert.equal(normalizeCustomerName(undefined), "");

  // Genuinely different names must NOT produce the same key
  assert.notEqual(
    normalizeCustomerName("Maria Santos"),
    normalizeCustomerName("Maria Santos Jr."),
  );
  assert.notEqual(
    normalizeCustomerName("Maria Santos"),
    normalizeCustomerName("Mario Santos"),
  );
});

test("reservationQuerySchema validates page size options and defaults to 10", async () => {
  const { reservationQuerySchema } = await import(
    "../lib/validation/reservations.ts"
  );
  assert.equal(reservationQuerySchema.parse({}).pageSize, "10");
  assert.equal(reservationQuerySchema.parse({ pageSize: "20" }).pageSize, "20");
  assert.equal(reservationQuerySchema.parse({ pageSize: "50" }).pageSize, "50");
  assert.equal(reservationQuerySchema.parse({ pageSize: "all" }).pageSize, "all");
  // Invalid values fall back to default "10"
  assert.equal(reservationQuerySchema.parse({ pageSize: "100" }).pageSize, "10");
  assert.equal(reservationQuerySchema.parse({ pageSize: "invalid" }).pageSize, "10");
});
