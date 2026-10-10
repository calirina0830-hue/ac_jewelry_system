import assert from "node:assert/strict";
import test from "node:test";

import {
  NEW_STOCK_QUANTITY,
  resolveStockQuantity,
} from "../lib/stock/quantity.ts";

test("new stock defaults to one internal piece", () => {
  assert.equal(NEW_STOCK_QUANTITY, 1);
  assert.equal(resolveStockQuantity(), 1);
  assert.equal(resolveStockQuantity(null), 1);
});

test("existing multi-quantity stock is preserved", () => {
  assert.equal(resolveStockQuantity(2), 2);
  assert.equal(resolveStockQuantity(25), 25);
  assert.equal(resolveStockQuantity(0), 0);
});

test("invalid stored quantities are rejected", () => {
  assert.throws(() => resolveStockQuantity(-1));
  assert.throws(() => resolveStockQuantity(1.5));
});
