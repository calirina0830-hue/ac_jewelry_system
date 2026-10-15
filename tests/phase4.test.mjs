import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canRoleTransitionReservation,
  getReservationTransitions,
  isBusinessTransitionAllowed,
} from "../lib/reservations/status.ts";

const migrationUrl = new URL(
  "../supabase/migrations/202608180001_phase4_workflow_monitoring.sql",
  import.meta.url,
);
const catalogMigrationUrl = new URL(
  "../supabase/migrations/202608180004_catalog_stock_reservation_quantity.sql",
  import.meta.url,
);
const invoiceMigrationUrl = new URL(
  "../supabase/migrations/202610100001_invoice_delivery_notes.sql",
  import.meta.url,
);

test("business workflow permits delivery independently of payment status", () => {
  assert.equal(isBusinessTransitionAllowed("reserved", "paid"), true);
  assert.equal(isBusinessTransitionAllowed("reserved", "cancelled"), true);
  assert.equal(isBusinessTransitionAllowed("reserved", "delivered"), true);
  assert.equal(isBusinessTransitionAllowed("paid", "delivered"), true);
  assert.equal(isBusinessTransitionAllowed("paid", "reserved"), true);

  for (const [from, to] of [
    ["paid", "cancelled"],
    ["delivered", "paid"],
    ["cancelled", "paid"],
    ["cancelled", "delivered"],
  ]) {
    assert.equal(isBusinessTransitionAllowed(from, to), false);
  }
});

test("roles cannot bypass cancellation and transition rules", () => {
  assert.equal(canRoleTransitionReservation("admin", "reserved", "cancelled"), true);
  assert.equal(canRoleTransitionReservation("staff", "reserved", "paid"), true);
  assert.equal(canRoleTransitionReservation("staff", "reserved", "delivered"), true);
  assert.equal(canRoleTransitionReservation("staff", "paid", "delivered"), true);
  assert.equal(canRoleTransitionReservation("admin", "paid", "reserved"), true);
  assert.equal(canRoleTransitionReservation("staff", "paid", "reserved"), false);
  assert.equal(canRoleTransitionReservation("staff", "reserved", "cancelled"), false);
  assert.equal(canRoleTransitionReservation("viewer", "reserved", "paid"), false);
  assert.equal(canRoleTransitionReservation(undefined, "reserved", "paid"), false);
  assert.deepEqual(getReservationTransitions("viewer", "reserved"), []);
  assert.deepEqual(
    getReservationTransitions("staff", "reserved").map(({ to }) => to),
    ["delivered"],
  );
});

test("Paid requires the fully settled payment RPC while other transitions remain audited", async () => {
  const [workflowMigration, paymentMigration] = await Promise.all([
    readFile(
      new URL("../supabase/migrations/202608180003_reservation_pricing_payments_bulk.sql", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../supabase/migrations/202608190002_finalize_reservation_on_payment.sql", import.meta.url),
      "utf8",
    ),
  ]);
  const transitionFunction = workflowMigration.match(
    /create or replace function public\.transition_reservation_status[\s\S]*?\$function\$;/i,
  )?.[0];

  assert.ok(transitionFunction);
  assert.match(transitionFunction, /for update/i);
  assert.doesNotMatch(transitionFunction, /v_reservation\.status = 'reserved' and p_new_status = 'paid'/i);
  assert.match(transitionFunction, /v_reservation\.status = 'reserved'[\s\S]*?p_new_status = 'cancelled'/i);
  assert.match(transitionFunction, /v_reservation\.status = 'paid' and p_new_status = 'delivered'/i);
  assert.doesNotMatch(transitionFunction, /v_reservation\.status = 'paid' and p_new_status = 'cancelled'/i);
  assert.match(transitionFunction, /insert into public\.reservation_status_history/i);
  const paymentFunction = paymentMigration.match(
    /create or replace function public\.record_reservation_payment\([\s\S]*?\$function\$;/i,
  )?.[0];
  assert.ok(paymentFunction);
  assert.match(paymentFunction, /not v_reservation\.pricing_complete/i);
  assert.match(paymentFunction, /sum\(payment\.amount\)/i);
  assert.match(paymentFunction, /p_amount > v_balance[\s\S]*?payment_exceeds_balance/i);
  assert.match(paymentFunction, /status = case when v_balance = 0 then 'paid' else status end/i);
  assert.match(paymentFunction, /insert into public\.reservation_status_history/i);
  assert.match(paymentMigration, /drop function if exists public\.mark_reservation_paid/i);
});

test("delivery records independently from payment and invoice notes are version-checked", async () => {
  const migration = await readFile(invoiceMigrationUrl, "utf8");
  const transition = migration.match(
    /create or replace function public\.transition_reservation_status[\s\S]*?\$function\$;/i,
  )?.[0];
  const notes = migration.match(
    /create or replace function public\.update_reservation_invoice_notes[\s\S]*?\$function\$;/i,
  )?.[0];

  assert.ok(transition);
  assert.match(transition, /status = case[\s\S]*?then v_reservation\.status/i);
  assert.match(transition, /delivered_at = case[\s\S]*?then v_now/i);
  assert.match(transition, /delivered_at is null/i);
  assert.ok(notes);
  assert.match(notes, /for update/i);
  assert.match(notes, /updated_at is distinct from p_expected_updated_at/i);
  assert.match(notes, /notes = nullif\(btrim\(p_notes\), ''\)/i);
});

test("catalog selection includes active non-archived stock without quantity holds", async () => {
  const migration = await readFile(catalogMigrationUrl, "utf8");
  const availabilityFunction = migration.match(
    /create or replace function public\.get_reservable_stock[\s\S]*?\$function\$;/i,
  )?.[0];

  assert.ok(availabilityFunction);
  assert.match(availabilityFunction, /stock\.is_active/i);
  assert.match(availabilityFunction, /stock\.archived_at is null/i);
  assert.doesNotMatch(availabilityFunction, /reservation_items/i);
  assert.doesNotMatch(availabilityFunction, /stock\.quantity\s*>/i);
});

test("category and dashboard monitoring use database-derived snapshots", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(migration, /add column category text/i);
  assert.match(migration, /v_category := v_stock\.category/i);
  assert.match(migration, /get_reservation_category_metrics/i);
  assert.match(migration, /reserved_quantity bigint/i);
  assert.match(migration, /paid_quantity bigint/i);
  assert.match(migration, /committed_value numeric/i);
  assert.match(migration, /reserved_count bigint/i);
  assert.match(migration, /paid_count bigint/i);
  assert.match(migration, /outstanding_balance numeric/i);
});

test("reservation summaries keep customer name primary and social name secondary", async () => {
  const [listPage, detailPage, form] = await Promise.all([
    readFile(new URL("../app/(dashboard)/reservations/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/(dashboard)/reservations/[id]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/reservations/reservation-form.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(listPage, /reservation\.customer_name/);
  assert.equal(listPage.includes("Facebook / CS:"), true);
  assert.match(detailPage, /label="Customer name"/);
  assert.equal(detailPage.includes('label="Facebook / CS"'), true);
  assert.match(form, /label="Customer name"/);
  assert.match(form, /label="Reservation number"/);
  assert.match(form, /label="Status"/);
  assert.match(form, /label="Quantity"/);
});

test("reservation operational views preserve status and search only seller identities", async () => {
  const listPage = await readFile(
    new URL("../app/(dashboard)/reservations/page.tsx", import.meta.url),
    "utf8",
  );

  for (const status of ["reserved", "paid", "delivered", "cancelled"]) {
    assert.match(listPage, new RegExp('value: "' + status + '"'));
  }
  assert.equal(listPage.includes("reservation_no.ilike"), true);
  assert.equal(listPage.includes("customer_name.ilike"), true);
  assert.equal(listPage.includes("customer_facebook_name.ilike"), true);
  assert.equal(listPage.includes("customer_email.ilike"), false);
  assert.equal(listPage.includes("customer_phone.ilike"), false);
  assert.match(listPage, /status=all&archive=archived/);
});

test("reservation selectors use bounded authenticated search without email labels", async () => {
  const [form, options, stockRoute] = await Promise.all([
    readFile(new URL("../components/reservations/reservation-form.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/reservations/form-options.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/reservation-options/stock/route.ts", import.meta.url), "utf8"),
  ]);

  assert.equal(form.includes('"/reservation-options/customers"'), true);
  assert.equal(form.includes('"/reservation-options/stock"'), true);
  assert.equal(form.includes("/reservation-options/customers?q="), false);
  assert.equal(form.includes("/reservation-options/stock?q="), false);
  assert.match(form, /method:\s*"POST"/);
  assert.match(form, /Search jewelry item\.\.\./);
  assert.match(form, /function JewelryItemCombobox/);
  assert.match(form, /ArrowDown/);
  assert.match(form, /onMouseDown/);
  assert.match(form, /candidate\.key !== item\.key/);
  assert.match(form, /Search customer name or FB \/ CS name\.\.\./);
  assert.equal(form.includes('label="Search customers"'), false);
  assert.equal(form.includes("Select customer"), false);
  assert.match(form, /Quantity/);
  assert.equal(form.includes("quantityInput"), true);
  assert.match(form, /(?:Code|SKU):\s*<\/span>\s*\{option\.sku/);
  assert.equal(form.includes("customer.email"), false);
  assert.match(options, /INITIAL_OPTION_LIMIT = 30/);
  assert.match(stockRoute, /name\.ilike/);
  assert.match(stockRoute, /sku\.ilike/);
  assert.equal(stockRoute.includes("availableQuantity"), false);
});

test("customer UI and search use name, Facebook / CS, and phone without email", async () => {
  const [form, list, detail, action] = await Promise.all([
    readFile(new URL("../components/customers/customer-form.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/(dashboard)/customers/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/(dashboard)/customers/[id]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../actions/customers.ts", import.meta.url), "utf8"),
  ]);

  assert.equal(form.includes('name="email"'), false);
  assert.equal(form.includes("Email address"), false);
  assert.equal(list.includes("name.ilike"), true);
  assert.equal(list.includes("facebook_name.ilike"), true);
  assert.equal(list.includes("phone.ilike"), true);
  assert.equal(list.includes("email.ilike"), false);
  assert.equal(detail.includes('label="Email"'), false);
  assert.equal(action.includes('getTextField(formData, "email")'), false);
});

test("stock UI is catalog-only while actions preserve the legacy database quantity", async () => {
  const [form, list, detail, dashboard, action] = await Promise.all([
    readFile(new URL("../components/stock/stock-form.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/(dashboard)/stock/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/(dashboard)/stock/[id]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/(dashboard)/dashboard/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../actions/stock.ts", import.meta.url), "utf8"),
  ]);

  assert.equal(form.includes('name="quantity"'), false);
  assert.equal(form.includes('name="isActive"'), false);
  assert.equal(form.includes('label="Availability"'), false);
  assert.equal(form.includes('name="price"'), false);
  assert.equal(list.includes("formatCurrency"), false);
  assert.equal(list.includes(">Quantity<"), false);
  assert.equal(list.includes("Low stock"), false);
  assert.equal(detail.includes('label="Quantity"'), false);
  assert.equal(detail.includes("Low stock"), false);
  assert.equal(dashboard.includes("Low stock"), false);
  assert.equal(action.includes('getTextField(formData, "price")'), false);
  assert.equal(action.includes("price: 0"), true);
  assert.equal(action.includes("quantity: resolveStockQuantity()"), true);
  assert.equal(
    action.includes("quantity: resolveStockQuantity(existing.quantity)"),
    true,
  );
  assert.equal(action.includes('isActive: existing.is_active ? "true" : "false"'), true);
});

test("reservation creation locks catalog entries but does not enforce Stock quantity", async () => {
  const migration = await readFile(catalogMigrationUrl, "utf8");
  const prepareFunction = migration.match(
    /create or replace function public\.prepare_reservation_items[\s\S]*?\$function\$;/i,
  )?.[0];

  assert.ok(prepareFunction);
  assert.match(prepareFunction, /for update/i);
  assert.match(
    prepareFunction,
    /not v_stock\.is_active\s+or v_stock\.archived_at is not null/i,
  );
  assert.match(prepareFunction, /v_unit_price \* v_quantity/i);
  assert.doesNotMatch(prepareFunction, /v_stock\.quantity - v_held/i);
  assert.doesNotMatch(prepareFunction, /insufficient_stock/i);
});
