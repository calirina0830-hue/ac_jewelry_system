import assert from "node:assert/strict";
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

test("stock option sources expose the item category", async () => {
  const [formOptions, route, database] = await Promise.all([
    readFile(
      new URL("../lib/reservations/form-options.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/reservation-options/stock/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../types/database.ts", import.meta.url), "utf8"),
  ]);

  assert.match(formOptions, /category: item\.category/);
  assert.match(route, /category: item\.category/);
  assert.match(database, /get_reservable_stock[\s\S]*?category: string;/);
});

test("reservation edit page loads the stored item category", async () => {
  const page = await readFile(
    new URL(
      "../app/(dashboard)/reservations/[id]/edit/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(page, /category: item\.category \?\? ""/);
});

test("reservation form shows SKU, item name, and category per item", async () => {
  const form = await readFile(
    new URL("../components/reservations/reservation-form.tsx", import.meta.url),
    "utf8",
  );

  assert.match(form, /const itemSku = selectedStock\?\.sku \?\? item\.sku;/);
  assert.match(
    form,
    /const itemCategory = selectedStock\?\.category \?\? item\.category;/,
  );
  assert.match(form, /itemSku \? "SKU " \+ itemSku : "SKU —"/);
  assert.match(
    form,
    /itemCategory \? "Category " \+ itemCategory : "Category —"/,
  );
  assert.match(form, /category: selected\.category/);
  assert.match(form, /category: selected\?\.category \?\? ""/);
  assert.match(form, /category: "",/);
  assert.match(form, /SKU:\s*<\/span>\s*\{option\.sku/);
  assert.match(form, /Item:\s*<\/span>\s*\{option\.name/);
  assert.match(form, /Category:\s*<\/span>\s*<span[^>]*>\{option\.category/);
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
