import assert from "node:assert/strict";
import test from "node:test";

import {
  createCustomerSchema,
  updateCustomerSchema,
} from "../lib/validation/customers.ts";

const validName = "Maria Santos";

test("1. accepts name only", () => {
  const result = createCustomerSchema.parse({ name: validName });

  assert.deepEqual(result, {
    name: validName,
    facebookName: null,
    phone: null,
    address: null,
    notes: null,
  });
});

test("2. creates a customer without email", () => {
  const result = createCustomerSchema.parse({
    name: validName,
    facebookName: "Maria S. Jewelry",
    phone: "09171234567",
  });

  assert.equal(result.facebookName, "Maria S. Jewelry");
  assert.equal(result.phone, "09171234567");
  assert.equal("email" in result, false);
});

test("3. accepts supported Philippine phone formats", () => {
  for (const phone of [
    "09171234567",
    "+639171234567",
    "+63 917 123 4567",
  ]) {
    const result = createCustomerSchema.parse({ name: validName, phone });
    assert.equal(result.phone, phone);
  }
});

test("4. edits a customer without email", () => {
  const result = updateCustomerSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    updatedAt: "2026-08-17T12:34:56.123+00:00",
    name: validName,
    phone: "09171234567",
  });

  assert.equal(result.phone, "09171234567");
  assert.equal("email" in result, false);
});

test("5. accepts name and address", () => {
  const result = createCustomerSchema.parse({
    name: validName,
    address: "Makati City",
  });

  assert.equal(result.address, "Makati City");
});

test("6. accepts name and notes", () => {
  const result = createCustomerSchema.parse({
    name: validName,
    notes: "Prefers white gold.",
  });

  assert.equal(result.notes, "Prefers white gold.");
});

test("7. accepts all seller-facing customer fields", () => {
  const result = createCustomerSchema.parse({
    name: validName,
    facebookName: "Maria S. Jewelry",
    phone: "+63 917 123 4567",
    address: "Makati City",
    notes: "Prefers white gold.",
  });

  assert.equal(result.name, validName);
});

test("8. normalizes blank optional fields to null", () => {
  const result = createCustomerSchema.parse({
    name: "  Maria Santos  ",
    phone: "",
    address: "   ",
    notes: "",
  });

  assert.deepEqual(result, {
    name: validName,
    facebookName: null,
    phone: null,
    address: null,
    notes: null,
  });
});

test("9. ignores legacy email input instead of making it seller-editable", () => {
  const result = createCustomerSchema.parse({
    name: validName,
    email: "legacy@example.com",
  });

  assert.equal("email" in result, false);
});

test("10. reports the exact phone field error", () => {
  const result = createCustomerSchema.safeParse({
    name: validName,
    phone: "12345",
  });

  assert.equal(result.success, false);
  assert.deepEqual(result.error.flatten().fieldErrors.phone, [
    "Enter a valid phone number.",
  ]);
});

test("update accepts Supabase timestamps with a UTC offset", () => {
  const result = updateCustomerSchema.safeParse({
    id: "11111111-1111-4111-8111-111111111111",
    updatedAt: "2026-08-17T12:34:56.123+00:00",
    name: validName,
  });

  assert.equal(result.success, true);
});

test("Facebook / CS name is optional, trimmed, and length-limited", () => {
  const valid = createCustomerSchema.parse({
    name: validName,
    facebookName: "  Maria S. Jewelry  ",
  });
  assert.equal(valid.facebookName, "Maria S. Jewelry");

  const blank = createCustomerSchema.parse({
    name: validName,
    facebookName: "   ",
  });
  assert.equal(blank.facebookName, null);

  const tooLong = createCustomerSchema.safeParse({
    name: validName,
    facebookName: "x".repeat(161),
  });
  assert.equal(tooLong.success, false);
  assert.deepEqual(tooLong.error.flatten().fieldErrors.facebookName, [
    "Facebook / CS name is too long.",
  ]);
});
