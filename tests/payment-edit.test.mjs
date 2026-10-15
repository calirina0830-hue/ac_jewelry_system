import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { editPaymentSchema } from "../lib/validation/payments.ts";

const paymentId = "11111111-1111-4111-8111-111111111111";
const reservationId = "22222222-2222-4222-8222-222222222222";
const timestamps = {
  expectedUpdatedAt: "2026-10-15T12:00:00.000Z",
  expectedPaymentRecordedAt: "2026-10-14T12:00:00.000Z",
};

test("payment edit validation accepts corrected amounts and optional details", () => {
  const base = {
    paymentId,
    reservationId,
    ...timestamps,
    amount: "500.25",
    paymentMethod: "",
    referenceNo: "",
    notes: "",
  };
  const parsed = editPaymentSchema.safeParse(base);

  assert.equal(parsed.success, true);
  assert.equal(parsed.data.amount, 50025);
  assert.equal(
    editPaymentSchema.safeParse({ ...base, amount: "-25.50" }).data.amount,
    -2550,
  );
  assert.equal(editPaymentSchema.safeParse({ ...base, amount: "0" }).success, false);
  assert.equal(
    editPaymentSchema.safeParse({ ...base, expectedPaymentRecordedAt: "not-a-date" })
      .success,
    false,
  );
});

test("payment corrections use an audited, locked database replacement", async () => {
  const [migration, reliabilityMigration, roleFixMigration, action, detail, dialog, historyDialog] = await Promise.all([
    readFile(
      new URL("../supabase/migrations/202610260001_edit_reservation_payment.sql", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../supabase/migrations/202610310001_reliable_payment_edit.sql", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../supabase/migrations/202611010001_fix_payment_role_enum.sql", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../actions/payments.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/(dashboard)/reservations/[id]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/reservations/edit-payment-record.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/reservations/payment-edit-history.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(migration, /coalesce\(public\.current_profile_role\(\)::text, ''\) not in \('admin', 'staff'\)/i);
  assert.match(migration, /for update/i);
  assert.match(migration, /updated_at is distinct from p_expected_reservation_updated_at/i);
  assert.match(migration, /recorded_at is distinct from p_expected_payment_recorded_at/i);
  assert.doesNotMatch(migration, /reservation_downpayment_committed/i);
  assert.doesNotMatch(migration, /downpayment\s*=/i);
  assert.match(migration, /insert into public\.reservation_payments/i);
  assert.match(migration, /voided_at = v_now[\s\S]*voided_by = v_user_id/i);
  assert.match(migration, /'reservationId', v_reservation_id/i);
  assert.doesNotMatch(migration, /delete from public\.reservation_payments/i);
  assert.match(action, /rpc\("edit_reservation_payment"/);
  assert.match(action, /stale_reservation[\s\S]*currentPayment[\s\S]*runEdit\(currentReservation\.updated_at\)/);
  assert.match(action, /currentPayment\.recorded_at === parsed\.data\.expectedPaymentRecordedAt/);
  assert.match(action, /!currentPayment\.voided_at/);
  assert.match(action, /PGRST202[\s\S]*payment-edit-migration-required/);
  assert.match(action, /22P02[\s\S]*profile_role[\s\S]*payment-edit-migration-required/);
  assert.match(detail, /<EditPaymentRecord/);
  assert.match(detail, /Edited and replaced by payment/);
  assert.match(
    detail,
    /visiblePayments = \(payments \?\? \[\]\)\.filter[\s\S]*!payment\.void_reason\?\.startsWith\("Edited and replaced by payment "\)/,
  );
  assert.match(detail, /visiblePayments\.map\(\(payment\)/);
  assert.match(detail, /<PaymentEditHistory entries=\{editHistory\}/);
  assert.match(dialog, /Saving keeps the original record in the audit history as voided/);
  assert.match(dialog, /payment-edit-migration-required/);
  assert.match(historyDialog, /Edit history/);
  assert.match(historyDialog, /Previous amount/);
  assert.match(historyDialog, /Edited amount/);
  assert.match(reliabilityMigration, /create or replace function public\.edit_reservation_payment/i);
  assert.match(reliabilityMigration, /drop constraint if exists reservations_balance_consistent/i);
  assert.match(reliabilityMigration, /drop constraint if exists reservation_payments_amount_positive/i);
  assert.match(reliabilityMigration, /reservation_payments_amount_nonzero/i);
  assert.match(reliabilityMigration, /recorded_at is distinct from p_expected_payment_recorded_at/i);
  assert.doesNotMatch(reliabilityMigration, /updated_at is distinct from p_expected_reservation_updated_at/i);
  assert.match(reliabilityMigration, /for update/i);
  assert.match(roleFixMigration, /current_profile_role\(\)::text/i);
  assert.match(roleFixMigration, /edit_reservation_payment/i);
});

test("new payment ledger entries cannot exceed the discounted item total", async () => {
  const migration = await readFile(
    new URL("../supabase/migrations/202610270001_prevent_payment_over_item_total.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /create constraint trigger[\s\S]*deferrable initially deferred/i);
  assert.match(migration, /sum\(\(item\.unit_price \* item\.quantity\) - item\.discount\)/i);
  assert.match(migration, /v_items_total := greatest\(v_items_subtotal - v_reservation\.discount, 0\)/i);
  assert.match(migration, /sum\(payment\.amount\)/i);
  assert.match(migration, /payment_exceeds_items_total/i);
  assert.match(migration, /payment\.voided_at is null/i);
});

test("payment totals drive Paid status without overwriting downpayment", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/202610300001_separate_downpayment_from_payments.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const cleanupMigration = await readFile(
    new URL(
      "../supabase/migrations/202610290001_sync_downpayment_from_payment_ledger.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(migration, /drop trigger if exists reservation_payments_sync_totals_from_ledger/i);
  assert.match(migration, /drop constraint if exists reservations_balance_consistent/i);
  assert.match(migration, /payment_exceeds_balance/i);
  assert.match(migration, /v_new_status := case when v_balance = 0 then 'paid' else 'reserved' end/i);
  assert.match(migration, /reservation payment status aligned with the active payment ledger/i);
  assert.match(migration, /downpayment = existing\.downpayment \+ v_created\.downpayment/i);
  assert.match(
    migration,
    /Release commitments are backed by reservations\.downpayment, not by the/i,
  );
  assert.match(migration, /unexpected_payment_commitment_check/i);
  assert.doesNotMatch(cleanupMigration, /set\s+downpayment\s*=/i);
  assert.match(migration, /v_definition_lines := string_to_array/i);
  assert.match(migration, /downpayment = downpayment/i);
  assert.match(
    migration,
    /right\(rtrim\(v_line,[\s\S]*chr\(13\)\), 1\) = ','/i,
  );
});

test("remaining items with zero payable balance move to Paid", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/202611020001_sync_paid_status_from_remaining_items.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(migration, /status not in \('reserved', 'paid'\)/i);
  assert.match(migration, /shipment\.status in \('pending', 'shipped'\)/i);
  assert.match(migration, /payment\.voided_at is null/i);
  assert.match(migration, /v_total_paid - v_applied_to_releases/i);
  assert.match(migration, /when v_remaining_quantity <= 0 then v_reservation\.status/i);
  assert.match(migration, /when v_remaining_balance = 0 then 'paid'/i);
  assert.match(migration, /else 'reserved'/i);
  assert.match(migration, /Remaining reservation items are fully paid/i);
  assert.match(migration, /Move existing qualifying reservations into Paid immediately/i);
});

test("payment deletion is audited and independent from downpayment commitments", async () => {
  const [migration, separationMigration, page, action, notice] = await Promise.all([
    readFile(
      new URL("../supabase/migrations/202610280001_delete_reservation_payment.sql", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../supabase/migrations/202610300001_separate_downpayment_from_payments.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../app/(dashboard)/reservations/[id]/page.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../actions/payments.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/ui/page-notice.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(migration, /create or replace function public\.delete_reservation_payment/i);
  assert.doesNotMatch(migration, /reservation_downpayment_committed/i);
  assert.match(
    separationMigration,
    /to_regprocedure\('public\.delete_reservation_payment\([^)]+\)'\)/i,
  );
  assert.match(separationMigration, /unexpected_payment_commitment_check/i);
  assert.match(migration, /voided_at = v_now[\s\S]*voided_by = v_user_id/i);
  assert.match(migration, /void_reason = 'Deleted from active totals/);
  assert.doesNotMatch(migration, /downpayment\s*=/i);
  assert.match(migration, /set[\s\S]*balance = v_balance[\s\S]*status = v_new_status/i);
  assert.doesNotMatch(migration, /delete from public\.reservation_payments/i);
  assert.match(page, /deleteReservationPayment\.bind/);
  assert.match(page, />\s*Delete\s*<\/ConfirmAction>/);
  assert.match(action, /deduction_exceeds_paid[\s\S]*payment-delete-deduction-exceeds-paid/);
  assert.match(action, /PGRST202[\s\S]*payment-delete-migration-required/);
  assert.match(notice, /payment-delete-deduction-exceeds-paid/);
  assert.match(notice, /payment-delete-migration-required/);
});

test("active payment records control balance without replacing downpayment", async () => {
  const [cleanupMigration, migration, runner] = await Promise.all([
    readFile(
      new URL(
        "../supabase/migrations/202610290001_sync_downpayment_from_payment_ledger.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../supabase/migrations/202610300001_separate_downpayment_from_payments.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(new URL("../run_migrations.sh", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(cleanupMigration, /set\s+downpayment\s*=/i);
  assert.match(migration, /drop trigger if exists reservation_payments_sync_totals_from_ledger/i);
  assert.match(migration, /balance = v_balance[\s\S]*status = v_new_status/i);
  assert.match(migration, /reservation_downpayment_committed/i);
  assert.doesNotMatch(migration, /downpayment = v_active_paid/i);
  assert.match(runner, /202610290001_sync_downpayment_from_payment_ledger\.sql/);
  assert.match(runner, /202610300001_separate_downpayment_from_payments\.sql/);
});
