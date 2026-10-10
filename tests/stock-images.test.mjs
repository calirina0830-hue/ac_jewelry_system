import assert from "node:assert/strict";
import test from "node:test";

import { isSafeStockImagePath } from "../lib/storage/stock-images.ts";

test("stock image paths accept current and legacy private bucket layouts", () => {
  assert.equal(
    isSafeStockImagePath(
      "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.webp",
    ),
    true,
  );
  assert.equal(isSafeStockImagePath("legacy/2024/Ring photo 01.jpeg"), true);
  assert.equal(isSafeStockImagePath("stock-items/bracelets/gold.png"), true);
});

test("stock image paths reject traversal and non-image objects", () => {
  assert.equal(isSafeStockImagePath("../private.txt"), false);
  assert.equal(isSafeStockImagePath("folder/../secret.jpg"), false);
  assert.equal(isSafeStockImagePath("/absolute/image.png"), false);
  assert.equal(isSafeStockImagePath("folder\\\\image.png"), false);
});
