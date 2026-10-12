import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { STOCK_CATEGORY_MAX_LENGTH } from "../lib/constants/stock.ts";
import { stockFormSchema, stockQuerySchema } from "../lib/validation/stock.ts";

function baseStockForm(overrides = {}) {
  return {
    sku: "rng-001",
    name: "18K Gold Solitaire Ring",
    description: "",
    category: "Ring",
    quantity: "1",
    isActive: "true",
    ...overrides,
  };
}

test("stock form accepts preset and free-form custom categories", () => {
  assert.equal(stockFormSchema.parse(baseStockForm()).category, "Ring");

  const custom = stockFormSchema.parse(
    baseStockForm({ category: "  Brooch  " }),
  );
  assert.equal(custom.category, "Brooch");
});

test("stock form rejects empty, oversized, and control-character categories", () => {
  assert.equal(
    stockFormSchema.safeParse(baseStockForm({ category: "" })).success,
    false,
  );
  assert.equal(
    stockFormSchema.safeParse(
      baseStockForm({ category: "x".repeat(STOCK_CATEGORY_MAX_LENGTH + 1) }),
    ).success,
    false,
  );
  assert.equal(
    stockFormSchema.safeParse(baseStockForm({ category: "Bad\nCategory" }))
      .success,
    false,
  );
});

test("stock query keeps custom category filters and defaults invalid values to all", () => {
  assert.equal(stockQuerySchema.parse({ category: "Brooch" }).category, "Brooch");
  assert.equal(stockQuerySchema.parse({}).category, "all");
  assert.equal(stockQuerySchema.parse({ category: "" }).category, "all");
  assert.equal(
    stockQuerySchema.parse({ category: "x".repeat(100) }).category,
    "all",
  );
});

test("stock form exposes an Other category text box and submits one category", async () => {
  const form = await readFile(
    new URL("../components/stock/stock-form.tsx", import.meta.url),
    "utf8",
  );

  assert.match(form, /name="categoryChoice"/);
  assert.match(form, /STOCK_CATEGORY_OTHER/);
  assert.match(form, /label="Other category"/);
  assert.match(form, /name="category"/);
  assert.match(form, /type="hidden"/);
  assert.match(form, /setCategoryChoice/);
  assert.match(form, /setCustomCategory/);
});

test("stock list unions presets with saved categories for filtering", async () => {
  const page = await readFile(
    new URL("../app/(dashboard)/stock/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(page, /\.select\("category"\)/);
  assert.match(page, /STOCK_CATEGORIES/);
  assert.match(page, /new Set\(\[/);
  assert.match(page, /categories\.map\(/);
});

test("stock category migration relaxes the fixed-value check", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/202610140001_stock_custom_category.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(migration, /drop constraint if exists stock_items_category_valid/i);
  assert.match(migration, /stock_items_category_length/);
  assert.match(
    migration,
    /char_length\(btrim\(category\)\) between 1 and 40/i,
  );
});
