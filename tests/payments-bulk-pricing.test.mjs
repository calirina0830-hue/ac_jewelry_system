import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_PAYMENT_EVIDENCE_ATTACHMENTS,
  MAX_PAYMENT_EVIDENCE_BYTES,
} from "../lib/constants/payments.ts";
import { getInvoiceTotals } from "../lib/reservations/invoice.ts";
import { centsToDecimal } from "../lib/reservations/money.ts";
import {
  canRecordReservationPayment,
  needsReservationPricing,
} from "../lib/reservations/payment-eligibility.ts";
import {
  buildBulkPaymentHref,
  parseBulkPaymentIds,
} from "../lib/reservations/payment-selection.ts";
import { calculatePaymentTransactionSummary } from "../lib/reservations/payment-transaction.ts";
import {
  buildPaymentEvidencePath,
  getPaymentEvidenceUrl,
  isExpectedPaymentEvidenceUploadPath,
  isSafePaymentEvidencePath,
  sanitizePaymentEvidenceFileName,
  validatePaymentEvidence,
} from "../lib/storage/payment-evidence.ts";
import {
  paymentBatchIdsSchema,
  paymentEvidenceListSchema,
  paymentEntrySchema,
  revertReasonSchema,
} from "../lib/validation/payments.ts";
import { reservationQuerySchema } from "../lib/validation/reservations.ts";

const migrationUrl = new URL(
  "../supabase/migrations/202608180003_reservation_pricing_payments_bulk.sql",
  import.meta.url,
);
const partialPaymentsMigrationUrl = new URL(
  "../supabase/migrations/202608180005_partial_payments_multiple_evidence.sql",
  import.meta.url,
);
const directUploadMigrationUrl = new URL(
  "../supabase/migrations/202608190001_constrain_direct_payment_evidence_uploads.sql",
  import.meta.url,
);
const finalPaymentMigrationUrl = new URL(
  "../supabase/migrations/202608190002_finalize_reservation_on_payment.sql",
  import.meta.url,
);
const deductionMigrationUrl = new URL(
  "../supabase/migrations/202610130001_payment_deductions.sql",
  import.meta.url,
);

function fakeFile(bytes, type) {
  const body = Uint8Array.from(bytes).buffer;
  return { size: body.byteLength, type, arrayBuffer: async () => body };
}

test("manual reservation payment validation normalizes signed amounts and rejects zero", () => {
  const valid = paymentEntrySchema.parse({
    reservationId: "11111111-1111-4111-8111-111111111111",
    expectedUpdatedAt: "2026-08-18T01:00:00+00:00",
    amount: "1299.50",
    paymentMethod: "GCash",
    referenceNo: "ABC123",
    notes: "Live payment",
  });
  assert.equal(valid.amount, 129950);
  assert.equal(paymentEntrySchema.safeParse({ ...valid, amount: "0" }).success, false);
  assert.equal(paymentEntrySchema.safeParse({ ...valid, amount: "abc" }).success, false);
  const deduction = paymentEntrySchema.parse({ ...valid, amount: "-500.00" });
  assert.equal(deduction.amount, -50000);
  assert.equal(centsToDecimal(deduction.amount), "-500.00");
  assert.equal(paymentEntrySchema.safeParse({ ...valid, amount: "-0.01" }).success, true);
  assert.equal(paymentEntrySchema.safeParse({ ...valid, amount: "-7.50" }).success, true);
  assert.equal(centsToDecimal(paymentEntrySchema.parse({ ...valid, amount: "-7.50" }).amount), "-7.50");
  assert.equal(paymentEntrySchema.safeParse({ ...valid, amount: "--5" }).success, false);
  assert.equal(paymentEntrySchema.safeParse({ ...valid, amount: "5.999" }).success, false);
  assert.equal(paymentEntrySchema.safeParse({ ...valid, amount: "" }).success, false);
  assert.equal(centsToDecimal(valid.amount), "1299.50");
  assert.equal(revertReasonSchema.safeParse(" ").success, false);
});

test("negative payment recalculates total paid and remaining balance", () => {
  const reservation = {
    subtotal: 2398,
    discount: 0,
    total: 2398,
    downpayment: 1000,
    balance: 1398,
  };
  const previousPaid = 1000;
  const paymentCents = paymentEntrySchema.parse({
    reservationId: "11111111-1111-4111-8111-111111111111",
    expectedUpdatedAt: "2026-08-18T01:00:00+00:00",
    amount: "-500",
    paymentMethod: "",
    referenceNo: "",
    notes: "",
  }).amount;
  assert.equal(paymentCents, -50000);

  const paymentAmount = Number(centsToDecimal(paymentCents));
  assert.equal(paymentAmount, -500);

  const totalPaid = previousPaid + paymentAmount;
  assert.equal(totalPaid, 500);

  const totals = getInvoiceTotals(reservation, totalPaid);
  assert.equal(totals.amountPaid, 500);
  assert.equal(totals.balance, 1898);
});

test("record payment totals use unreleased items and active payment records", () => {
  const summary = calculatePaymentTransactionSummary({
    originalTotal: 2200,
    reservationDiscount: 200,
    items: [
      {
        id: "item-1",
        sku: "R-1",
        itemName: "Ring",
        category: "Ring",
        quantity: 2,
        unitPrice: 1000,
        discount: 100,
      },
      {
        id: "item-2",
        sku: "N-1",
        itemName: "Necklace",
        category: "Necklace",
        quantity: 1,
        unitPrice: 500,
        discount: 0,
      },
    ],
    shipments: [
      {
        id: "release-1",
        status: "shipped",
        downpaymentApplied: 600,
      },
      {
        id: "cancelled-release",
        status: "cancelled",
        downpaymentApplied: 999,
      },
    ],
    shipmentItems: [
      {
        shipmentId: "release-1",
        reservationItemId: "item-1",
        quantity: 1,
      },
      {
        shipmentId: "cancelled-release",
        reservationItemId: "item-2",
        quantity: 1,
      },
    ],
    payments: [500, 300],
  });

  assert.equal(summary.originalTotal, 2200);
  assert.equal(summary.remainingItemsSubtotal, 1450);
  assert.equal(summary.remainingReservationDiscount, 120);
  assert.equal(summary.remainingItemsTotal, 1330);
  assert.equal(summary.totalPaid, 800);
  assert.equal(summary.paymentCount, 2);
  assert.equal(summary.appliedToReleases, 600);
  assert.equal(summary.paidTowardRemaining, 200);
  assert.equal(summary.remainingBalance, 1130);
  assert.deepEqual(
    summary.items.map((item) => ({
      id: item.id,
      released: item.releasedQuantity,
      remaining: item.remainingQuantity,
      total: item.remainingTotal,
    })),
    [
      { id: "item-1", released: 1, remaining: 1, total: 950 },
      { id: "item-2", released: 0, remaining: 1, total: 500 },
    ],
  );
});

test("payment evidence validates MIME plus image signature and safe authenticated paths", async () => {
  assert.equal(MAX_PAYMENT_EVIDENCE_ATTACHMENTS, 5);
  const png = await validatePaymentEvidence(
    fakeFile([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"),
  );
  assert.equal(png.success, true);
  assert.equal(
    (await validatePaymentEvidence(fakeFile([1, 2, 3], "image/png"))).success,
    false,
  );
  assert.equal(isSafePaymentEvidencePath("user/reservation/proof.webp"), true);
  assert.equal(isSafePaymentEvidencePath("../proof.webp"), false);
  assert.match(getPaymentEvidenceUrl("user/proof.jpg"), /^\/payment-evidence\?path=/);
});

test("direct payment evidence paths bind user, reservation, UUID, MIME, and metadata limits", async () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const reservationId = "22222222-2222-4222-8222-222222222222";
  const objectId = "33333333-3333-4333-8333-333333333333";
  const path = buildPaymentEvidencePath(userId, reservationId, objectId, "png");

  assert.equal(
    path,
    userId + "/" + reservationId + "/" + objectId + ".png",
  );
  assert.equal(
    isExpectedPaymentEvidenceUploadPath(
      path,
      userId,
      reservationId,
      "image/png",
    ),
    true,
  );
  assert.equal(
    isExpectedPaymentEvidenceUploadPath(
      path,
      "44444444-4444-4444-8444-444444444444",
      reservationId,
      "image/png",
    ),
    false,
  );
  assert.equal(
    isExpectedPaymentEvidenceUploadPath(
      path,
      userId,
      reservationId,
      "image/jpeg",
    ),
    false,
  );
  assert.equal(
    isExpectedPaymentEvidenceUploadPath(
      userId + "/" + reservationId + "/extra/" + objectId + ".png",
      userId,
      reservationId,
    ),
    false,
  );
  assert.throws(() =>
    buildPaymentEvidencePath("not-a-user", reservationId, objectId, "png"),
  );

  const metadata = {
    storage_path: path,
    original_file_name: sanitizePaymentEvidenceFileName(" proof.png ", "png"),
    mime_type: "image/png",
    file_size: MAX_PAYMENT_EVIDENCE_BYTES,
  };
  assert.equal(paymentEvidenceListSchema.safeParse([metadata]).success, true);
  assert.equal(
    paymentEvidenceListSchema.safeParse(
      Array.from({ length: MAX_PAYMENT_EVIDENCE_ATTACHMENTS + 1 }, () => metadata),
    ).success,
    false,
  );
  assert.equal(
    paymentEvidenceListSchema.safeParse([
      { ...metadata, file_size: MAX_PAYMENT_EVIDENCE_BYTES + 1 },
    ]).success,
    false,
  );

  const maximumSizeImage = await validatePaymentEvidence({
    size: MAX_PAYMENT_EVIDENCE_BYTES,
    type: "image/png",
    arrayBuffer: async () =>
      Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]).buffer,
  });
  assert.equal(maximumSizeImage.success, true);
});

test("four individually valid images may exceed 4.5 MB without becoming invalid", async () => {
  const imageSize = 1_200_000;
  const images = Array.from({ length: 4 }, () => ({
    size: imageSize,
    type: "image/jpeg",
    arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff]).buffer,
  }));

  assert.equal(images.reduce((total, image) => total + image.size, 0) > 4_500_000, true);
  assert.deepEqual(
    await Promise.all(
      images.map(async (image) => (await validatePaymentEvidence(image)).success),
    ),
    [true, true, true, true],
  );
});

test("partial payment totals accumulate while the invoice remains Reserved", () => {
  const reservation = {
    subtotal: 10000,
    discount: 0,
    total: 10000,
    downpayment: 0,
    balance: 10000,
  };
  assert.deepEqual(getInvoiceTotals(reservation, 3000), {
    subtotal: 10000,
    reservationDiscount: 0,
    total: 10000,
    amountPaid: 3000,
    balance: 7000,
  });
  assert.equal(getInvoiceTotals(reservation, 5000).balance, 5000);
  assert.equal(getInvoiceTotals(reservation, 10000).balance, 0);
});

test("payment table and private evidence bucket preserve append-only audit security", async () => {
  const [migration, partialMigration, directUploadMigration] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(partialPaymentsMigrationUrl, "utf8"),
    readFile(directUploadMigrationUrl, "utf8"),
  ]);
  assert.match(migration, /create table public\.reservation_payments/i);
  assert.match(migration, /reservation_id uuid not null[\s\S]*?references public\.reservations/i);
  assert.match(migration, /alter table public\.reservation_payments enable row level security/i);
  assert.match(migration, /grant select on table public\.reservation_payments to authenticated/i);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete) on table public\.reservation_payments/i);
  assert.match(migration, /'payment-evidence'[\s\S]*?false,[\s\S]*?5242880/i);
  assert.match(migration, /payment_evidence_insert_admin_staff/i);
  assert.match(migration, /storage\.foldername\(name\)/i);
  assert.match(partialMigration, /create table public\.reservation_payment_evidence/i);
  assert.match(partialMigration, /payment_id uuid not null[\s\S]*?references public\.reservation_payments/i);
  assert.match(partialMigration, /insert into public\.reservation_payment_evidence[\s\S]*?payment\.evidence_path/i);
  assert.match(partialMigration, /grant select on table public\.reservation_payment_evidence to authenticated/i);
  assert.doesNotMatch(partialMigration, /grant (?:insert|update|delete) on table public\.reservation_payment_evidence/i);
  assert.match(directUploadMigration, /to authenticated[\s\S]*?with check/i);
  assert.match(directUploadMigration, /current_profile_role\(\)[\s\S]*?'admin', 'staff'/i);
  assert.match(directUploadMigration, /auth\.uid\(\)::text/i);
  assert.match(directUploadMigration, /cardinality\(string_to_array\(name, '\/'\)\) = 3/i);
  assert.match(directUploadMigration, /\\\.\(jpg\|png\|webp\)/i);
  assert.doesNotMatch(directUploadMigration, /bucket_id = 'payment-evidence'\s*\);/i);
});

test("first and later partial payments append to the ledger and keep Reserved", async () => {
  const migration = await readFile(finalPaymentMigrationUrl, "utf8");
  const rpc = migration.match(
    /create or replace function public\.record_reservation_payment\([\s\S]*?\$function\$;/i,
  )?.[0];
  assert.ok(rpc);
  assert.match(rpc, /for update/i);
  assert.match(rpc, /pricing_incomplete/i);
  assert.match(rpc, /insert into public\.reservation_payments/i);
  assert.match(rpc, /voided_at is null/i);
  assert.match(rpc, /p_amount > v_balance[\s\S]*?payment_exceeds_balance/i);
  assert.match(rpc, /p_amount <= 0/i);
  assert.match(rpc, /downpayment = least\(total, v_total_paid\)/i);
  assert.match(rpc, /balance = v_balance/i);
  assert.match(rpc, /status = case when v_balance = 0 then 'paid' else status end/i);
  assert.match(rpc, /if v_balance = 0 then[\s\S]*?insert into public\.reservation_status_history/i);
  assert.doesNotMatch(rpc, /update public\.reservation_payments/i);
});

test("payment deductions append to the ledger without driving paid below zero", async () => {
  const migration = await readFile(deductionMigrationUrl, "utf8");
  const rpc = migration.match(
    /create or replace function public\.record_reservation_payment\([\s\S]*?\$function\$;/i,
  )?.[0];
  assert.ok(rpc);
  assert.match(rpc, /abs\(p_amount\) > 9999999999\.99/i);
  assert.match(rpc, /p_amount = 0/i);
  assert.doesNotMatch(rpc, /p_amount <= 0/i);
  assert.match(rpc, /if p_amount > 0 then[\s\S]*?reservation_already_settled/i);
  assert.match(rpc, /if p_amount > v_balance then[\s\S]*?payment_exceeds_balance/i);
  assert.match(rpc, /v_existing_paid \+ p_amount < 0[\s\S]*?deduction_exceeds_paid/i);
  assert.match(rpc, /downpayment = greatest\(least\(total, v_total_paid\), 0\)/i);
  assert.match(rpc, /insert into public\.reservation_payments/i);
  assert.match(migration, /drop constraint if exists reservation_payments_amount_positive/i);
  assert.match(migration, /add constraint reservation_payments_amount_nonzero[\s\S]*?check \(amount <> 0\)/i);
});

test("the final payment atomically reaches Paid and the Mark Paid shortcut is dropped", async () => {
  const migration = await readFile(finalPaymentMigrationUrl, "utf8");
  const rpc = migration.match(
    /create or replace function public\.record_reservation_payment\([\s\S]*?\$function\$;/i,
  )?.[0];
  assert.ok(rpc);
  assert.match(rpc, /for update/i);
  assert.match(rpc, /sum\(payment\.amount\)/i);
  assert.match(rpc, /v_total_paid := v_existing_paid \+ p_amount/i);
  assert.match(rpc, /v_balance := greatest\(v_reservation\.total - v_total_paid, 0\)/i);
  assert.match(rpc, /paid_at = case when v_balance = 0 then v_now else paid_at end/i);
  assert.match(rpc, /insert into public\.reservation_status_history/i);
  assert.match(rpc, /'fullySettled', v_balance = 0/i);
  assert.match(migration, /drop function if exists public\.mark_reservation_paid/i);
  assert.match(migration, /drop function if exists public\.bulk_mark_reservations_paid/i);
  assert.match(migration, /drop function if exists public\.record_reservation_payment_and_mark_paid/i);
});

test("each payment owns its evidence and submitted paths are reservation-scoped", async () => {
  const migration = await readFile(finalPaymentMigrationUrl, "utf8");
  const rpc = migration.match(
    /create or replace function public\.record_reservation_payment\([\s\S]*?\$function\$;/i,
  )?.[0];
  assert.ok(rpc);
  assert.match(rpc, /returning id into v_payment_id/i);
  assert.match(rpc, /insert into public\.reservation_payment_evidence/i);
  assert.match(rpc, /v_payment_id, v_path, v_original_name/i);
  assert.match(rpc, /foldername\(object\.name\)\)\[1\] = v_user_id::text/i);
  assert.match(rpc, /foldername\(object\.name\)\)\[2\] = p_reservation_id::text/i);
});

test("bulk cancellation and delivery validate all records before updating and audit each row", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const rpc = migration.match(
    /create or replace function public\.bulk_transition_reservations[\s\S]*?\$function\$;/i,
  )?.[0];
  assert.ok(rpc);
  assert.match(rpc, /for update/i);
  assert.match(rpc, /p_new_status = 'cancelled'[\s\S]*?v_role <> 'admin'/i);
  assert.match(rpc, /p_new_status = 'delivered'/i);
  assert.match(rpc, /insert into public\.reservation_status_history/i);
  assert.match(rpc, /cancelled_at = case/i);
  assert.match(rpc, /delivered_at = case/i);
});

test("Admin Paid to Reserved voids rather than deletes payments and keeps an audit reason", async () => {
  const migration = await readFile(partialPaymentsMigrationUrl, "utf8");
  const rpc = migration.match(
    /create or replace function public\.bulk_revert_paid_reservations[\s\S]*?\$function\$;/i,
  )?.[0];
  assert.ok(rpc);
  assert.match(rpc, /current_profile_role\(\) <> 'admin'/i);
  assert.match(rpc, /voided_at = v_now/i);
  assert.match(rpc, /void_reason = v_reason/i);
  assert.doesNotMatch(rpc, /delete from public\.reservation_payments/i);
  assert.match(rpc, /status = 'reserved'/i);
  assert.match(rpc, /paid_at = null/i);
  assert.match(rpc, /reason[\s\S]*?v_reason/i);
  assert.doesNotMatch(rpc, /reservation_payment_evidence[\s\S]*?delete/i);
});

test("bulk payment review records partial payments and cleans every failed upload", async () => {
  const [page, action, uploadForm, list, card] = await Promise.all([
    readFile(new URL("../app/(dashboard)/reservations/bulk/pay/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../actions/payments.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../components/reservations/payment-upload-form.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/(dashboard)/reservations/page.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../components/reservations/record-payment-card.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(page, /RecordPaymentCard/);
  assert.match(page, /PaymentUploadForm/);
  assert.match(card, /Payment amount/);
  assert.match(card, /Payment method/);
  assert.match(card, /PaymentEvidenceInput/);
  assert.doesNotMatch(card, /Paid after this payment/);
  assert.match(card, /Amount items to be paid/);
  assert.match(card, /Balance after this payment/);
  assert.match(card, /Items still requiring payment/);
  assert.match(card, /Applied to releases/);
  assert.match(page, /loadPaymentTransactionSummaries/);
  assert.match(action, /loadPaymentTransactionSummaries/);
  assert.match(action, /remainingBalance/);
  assert.match(action, /bulk_record_reservation_payments/);
  assert.doesNotMatch(action, /\.upload\(/);
  assert.match(action, /formData\.values\(\)[\s\S]*?instanceof File/);
  assert.match(action, /paymentEvidenceListSchema/);
  assert.match(action, /isExpectedPaymentEvidenceUploadPath/);
  assert.match(action, /\.download\(attachment\.storage_path\)/);
  assert.match(action, /validatePaymentEvidence\(data\)/);
  assert.match(action, /reservation_payment_evidence/);
  assert.match(action, /referenced[\s\S]*?removable/);
  assert.match(action, /cleanupEvidence/);
  assert.match(uploadForm, /createClient/);
  assert.match(uploadForm, /\.upload\(path, validation\.evidence\.body/);
  assert.match(uploadForm, /formData\.delete\(fieldName\)/);
  assert.match(uploadForm, /remainingFileFields/);
  assert.match(uploadForm, /getPaymentEvidenceMetadataFieldName/);
  assert.match(uploadForm, /recordReservationPayments\(formData\)/);
  assert.match(uploadForm, /uploadedPaths/);
  assert.match(uploadForm, /removeAttemptUploads/);
  assert.match(uploadForm, /upsert: false/);
  assert.match(uploadForm, /submittingRef\.current/);
  assert.doesNotMatch(uploadForm, /service.role|service_role/i);
  assert.doesNotMatch(page, /and Mark Paid/);
  assert.match(list, /BulkSelectAll/);
  assert.match(list, /BulkReviewButton destination="pay"/);
  assert.match(list, /BulkSubmitButton[\s\S]*?operation="deliver"/);
});

test("payment amount recomputes paid and remaining totals in real time", async () => {
  const card = await readFile(
    new URL("../components/reservations/record-payment-card.tsx", import.meta.url),
    "utf8",
  );

  for (const fragment of [
    "useState",
    "onChange",
    "name={\"amount:\" + reservation.id}",
    "totalPaid",
    "remaining",
    "setAmount",
  ]) {
    assert.match(card, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(
    card,
    /const payment = Number\.isFinite\(parsed\) \? parsed : 0;/,
  );
  assert.doesNotMatch(card, /parsed > 0 \? parsed : 0/);
  assert.doesNotMatch(card, /min="0\.01"/);
});

test("both payment inputs allow deductions and explain a rejected deduction", async () => {
  const [card, invoiceControls, page] = await Promise.all([
    readFile(
      new URL("../components/reservations/record-payment-card.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../components/reservations/invoice-controls.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/(dashboard)/reservations/bulk/pay/page.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.doesNotMatch(card, /min="0\.01"/);
  assert.doesNotMatch(invoiceControls, /min="0\.01"/);
  assert.match(invoiceControls, /deduction-exceeds-paid/);
  assert.match(page, /deduction-exceeds-paid/);
});

test("individual and bulk payment eligibility keeps partial reservations payable", async () => {
  const activeReserved = {
    archived_at: null,
    balance: 10000,
    pricing_complete: true,
    status: "reserved",
    total: 10000,
  };
  assert.equal(canRecordReservationPayment(activeReserved), true);
  assert.equal(
    canRecordReservationPayment({ ...activeReserved, balance: 7000 }),
    true,
  );
  assert.equal(
    canRecordReservationPayment({ ...activeReserved, balance: 2000 }),
    true,
  );
  assert.equal(
    canRecordReservationPayment({ ...activeReserved, balance: 0 }),
    false,
  );
  assert.equal(
    needsReservationPricing({ ...activeReserved, pricing_complete: false }),
    true,
  );

  for (const status of ["paid", "delivered", "cancelled"]) {
    assert.equal(
      canRecordReservationPayment({ ...activeReserved, status }),
      false,
    );
  }
  assert.equal(
    canRecordReservationPayment({
      ...activeReserved,
      archived_at: "2026-08-19T00:00:00Z",
    }),
    false,
  );

  const [list, detail, review, controls, notice] = await Promise.all([
    readFile(
      new URL("../app/(dashboard)/reservations/page.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/(dashboard)/reservations/[id]/page.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/(dashboard)/reservations/bulk/pay/page.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../components/reservations/bulk-reservation-controls.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../components/ui/page-notice.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(list, /canRecordReservationPayment\(reservation\)/);
  assert.doesNotMatch(list, /canMarkReservationPaid|markReservationPaid|Mark Paid/);
  assert.match(list, /needsReservationPricing\(reservation\)/);
  assert.match(detail, /canRecordReservationPayment\(reservation\)/);
  assert.doesNotMatch(detail, /canMarkReservationPaid|markReservationPaid|Mark as Paid/);
  assert.match(review, /reservations\.some\(\(item\) => !canRecordReservationPayment\(item\)\)/);
  assert.match(review, /roleCanWrite\(profile\?\.role\)/);
  assert.match(review, /idsResult\.data[\s\S]*?reservations\.find/);
  assert.match(list, /Record payments/);
  assert.match(list, /BulkSelectionCount/);
  assert.match(list, /BulkSelectionProvider/);
  assert.match(controls, /\{selectedIds\.length\} selected/);
  assert.match(controls, /Some selected reservations cannot receive a payment/);
  assert.match(controls, /disabled=\{selectedIds\.length === 0\}/);
  assert.match(controls, /w-full[\s\S]*?sm:w-auto/);
  assert.match(notice, /invalid-bulk-selection/);
});

test("bulk payment IDs survive navigation without duplicates or order loss", () => {
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const href = buildBulkPaymentHref([first, second, first]);
  const url = new URL(href, "http://localhost");

  assert.deepEqual(url.searchParams.getAll("ids"), [first, second]);
  assert.deepEqual(parseBulkPaymentIds(url.searchParams.getAll("ids")), [
    first,
    second,
  ]);
  assert.deepEqual(parseBulkPaymentIds(first + "," + second), [first, second]);
  assert.equal(
    paymentBatchIdsSchema.safeParse(
      parseBulkPaymentIds(url.searchParams.getAll("ids")),
    ).success,
    true,
  );
  assert.equal(paymentBatchIdsSchema.safeParse([]).success, false);
});

test("payment flow resets after cancel, navigation, and reservation changes", async () => {
  const [page, controls, evidence, uploadForm, menu] = await Promise.all([
    readFile(
      new URL("../app/(dashboard)/reservations/bulk/pay/page.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../components/reservations/payment-form-actions.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../components/reservations/payment-evidence-input.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../components/reservations/payment-upload-form.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../components/reservations/reservation-actions-menu.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(page, /PaymentFormActions/);
  assert.match(page, /RecordPaymentCard/);
  assert.match(controls, /usePaymentSubmissionPhase/);
  assert.match(controls, /form\?\.reset\(\)/);
  assert.match(controls, /disabled=\{pricingIncomplete \|\| pending\}/);
  assert.match(controls, /disabled=\{pending\}/);
  assert.match(controls, /Uploading evidence\.\.\./);
  assert.match(controls, /Recording payment\.\.\./);
  assert.match(controls, /router\.push\(destination\)/);
  assert.match(uploadForm, /phase === "uploading"/);
  assert.match(uploadForm, /phase === "recording"/);
  assert.match(uploadForm, /role="alert"/);
  assert.match(evidence, /addEventListener\("reset", resetEvidence\)/);
  assert.match(evidence, /setFiles\(\[\]\)/);
  assert.match(evidence, /setError\(""\)/);
  assert.match(evidence, /URL\.revokeObjectURL/);
  assert.match(menu, /flushSync\(\(\) => setOpen\(false\)\)/);
  assert.match(menu, /addEventListener\("pageshow", resetAfterNavigation\)/);
  assert.match(menu, /addEventListener\("popstate", resetAfterNavigation\)/);
});

test("payment evidence supports five previews and an accessible keyboard gallery", async () => {
  const [input, viewer, detail, route, nextConfig] = await Promise.all([
    readFile(
      new URL("../components/reservations/payment-evidence-input.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../components/reservations/payment-evidence-viewer.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/(dashboard)/reservations/[id]/page.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/payment-evidence/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
  ]);

  assert.match(input, /multiple/);
  assert.match(input, /MAX_PAYMENT_EVIDENCE_ATTACHMENTS/);
  assert.match(input, /Upload up to \{MAX_PAYMENT_EVIDENCE_ATTACHMENTS\} evidence images/);
  assert.match(input, /Remove/);
  assert.match(detail, /PaymentEvidenceViewer/);
  assert.match(detail, /evidenceByPayment/);
  assert.match(detail, /getPaymentEvidenceUrl\(payment\.evidence_path\)/);
  assert.match(viewer, /aria-modal="true"/);
  assert.match(viewer, /role="dialog"/);
  assert.match(viewer, /event\.key === "Escape"/);
  assert.match(viewer, /event\.key === "ArrowLeft"/);
  assert.match(viewer, /event\.key === "ArrowRight"/);
  assert.match(viewer, /Previous/);
  assert.match(viewer, /Next/);
  assert.match(viewer, /of \{items\.length\}/);
  assert.match(viewer, /document\.body\.style\.overflow = "hidden"/);
  assert.match(viewer, /data-evidence-content/);
  assert.match(viewer, /src=\{current\.url\}/);
  assert.match(route, /reservation_payment_evidence/);
  assert.match(nextConfig, /bodySizeLimit: "6mb"/);
  assert.doesNotMatch(detail, /target="_blank"[\s\S]*?View Evidence/);
});

test("Paid to Reserved reason is required and the control remains interactive", async () => {
  const page = await readFile(
    new URL("../app/(dashboard)/reservations/bulk/revert/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /Reason for reverting to Reserved/);
  assert.match(page, /name="reason"/);
  assert.match(page, /required/);
  assert.match(page, /pointer-events-auto/);
  assert.equal(revertReasonSchema.safeParse("No").success, false);
  assert.equal(
    revertReasonSchema.safeParse("Payment was recorded against the wrong reservation.").success,
    true,
  );
});

test("reservation filters combine search, status, and operational From and To dates", async () => {
  const page = await readFile(
    new URL("../app/(dashboard)/reservations/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /name="fromDate"/);
  assert.match(page, /name="toDate"/);
  assert.match(page, /operationalDateColumn/);
  assert.match(page, /filters\.status === "paid"[\s\S]*?"paid_at"/);
  assert.match(page, /query = query\.gte/);
  assert.match(page, /query = query\.lt/);
  assert.match(page, /reservation_no\.ilike/);
  assert.match(page, /query = query\.eq\("status", filters\.status\)/);
  const filters = reservationQuerySchema.parse({
    q: "Rina",
    status: "paid",
    fromDate: "2026-08-01",
    toDate: "2026-08-18",
  });
  assert.equal(filters.fromDate, "2026-08-01");
  assert.equal(filters.toDate, "2026-08-18");
  assert.equal(reservationQuerySchema.parse({ fromDate: "2026-02-30" }).fromDate, "");
});
