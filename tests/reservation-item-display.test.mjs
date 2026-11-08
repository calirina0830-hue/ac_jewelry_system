import assert from "node:assert/strict";
import { formatItemLabel } from "../lib/reservations/item-label.ts";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("reservation item types carry the stock category", async () => {
  const types = await readFile(
    new URL("../types/reservations.ts", import.meta.url),
    "utf8",
  );

  assert.match(types, /ReservationStockOption[\s\S]*?category: string;/);
  assert.match(types, /ReservationInitialItem[\s\S]*?category: string;/);
});

test("order form options no longer include a product catalog", async () => {
  const formOptions = await readFile(
    new URL("../lib/reservations/form-options.ts", import.meta.url),
    "utf8",
  );

  assert.equal(formOptions.includes("stock"), false);
  assert.equal(formOptions.includes("get_reservable_stock"), false);
});

test("reservation edit page loads the stored item category", async () => {
  const page = await readFile(
    new URL(
      "../lib/reservations/reservation-edit-data.ts",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(page, /category: item\.category \?\? ""/);
});

test("reservation form takes each item as typed text", async () => {
  const form = await readFile(
    new URL("../components/reservations/reservation-form.tsx", import.meta.url),
    "utf8",
  );

  assert.match(form, /placeholder="Type the item"/);
  assert.match(form, /itemName: item\.itemLabel/);
  assert.equal(form.includes("JewelryItemCombobox"), false);
  assert.equal(form.includes("/reservation-options/stock"), false);
  assert.equal(form.includes("InlineStockModal"), false);
});

test("typed items display as entered; older items keep code and category", () => {
  assert.equal(
    formatItemLabel({ sku: "ITEM-abc123", name: "Rosegold ring", category: "Item" }),
    "Rosegold ring",
  );
  assert.equal(
    formatItemLabel({ sku: "MSN", name: "MOISSANITE", category: "Necklace" }),
    "MSN - MOISSANITE - Necklace",
  );
});

test("reservable stock RPC exposes the category column", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/202610150001_reservable_stock_category.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(migration, /drop function if exists public\.get_reservable_stock\(uuid\)/i);
  assert.match(migration, /returns table \([\s\S]*?category text/i);
  assert.match(migration, /stock\.category/i);
  assert.match(migration, /stock\.is_active/i);
  assert.match(migration, /stock\.archived_at is null/i);
});
