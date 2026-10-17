#!/usr/bin/env bash
set -e

read -s -p "Enter Supabase DB password: " DB_PASS
echo ""

if [ -z "$DB_PASS" ]; then
  echo "Error: Password cannot be empty."
  exit 1
fi

CONN="host=aws-0-us-east-1.pooler.supabase.com port=5432 user=postgres.fvtolirchlcnqpvhxiiw dbname=postgres sslmode=require"

for sql_file in \
  supabase/migrations/202610110001_master_invoice_shipping.sql \
  supabase/migrations/202610110002_item_release_downpayment.sql \
  supabase/migrations/202610170001_release_items_with_date_and_notes.sql \
  supabase/migrations/202610190001_ensure_shipping_and_release_rpcs.sql \
  supabase/migrations/202610200001_relax_reservation_items_category_constraint.sql \
  supabase/migrations/202610210001_delete_archived_reservations.sql \
  supabase/migrations/202610220001_create_reservation_with_downpayment.sql \
  supabase/migrations/202610230001_reuse_customer_reservation.sql \
  supabase/migrations/202610240001_edit_reservation_downpayment.sql \
  supabase/migrations/202610250001_allow_unicode_customer_text.sql \
  supabase/migrations/202610260001_edit_reservation_payment.sql \
  supabase/migrations/202610270001_prevent_payment_over_item_total.sql \
  supabase/migrations/202610280001_delete_reservation_payment.sql \
  supabase/migrations/202610290001_sync_downpayment_from_payment_ledger.sql \
  supabase/migrations/202610300001_separate_downpayment_from_payments.sql \
  supabase/migrations/202610310001_reliable_payment_edit.sql \
  supabase/migrations/202611010001_fix_payment_role_enum.sql \
  supabase/migrations/202611020001_sync_paid_status_from_remaining_items.sql \
  supabase/migrations/202611030001_partially_paid_reservation_ids.sql \
  supabase/migrations/202611040002_restore_release_downpayment_source.sql \
  supabase/migrations/202611050001_exclude_delivered_from_reservation_merge.sql \
  supabase/migrations/202611050002_edit_payment_negative_adjustment.sql \
  supabase/migrations/202611050003_void_payment_with_remarks.sql \
  supabase/migrations/202611050004_release_corrections.sql \
  supabase/migrations/202611050005_merge_customer_reservations_until_fully_delivered.sql \
  supabase/migrations/202611050006_classify_partial_delivery_by_remaining_items.sql \
  supabase/migrations/202611070001_optimize_reservation_classification.sql \
  supabase/migrations/202611080001_merge_active_customer_reservations_regardless_of_date.sql
do
  echo "Applying $sql_file..."
  docker run --rm \
    -e PGPASSWORD="$DB_PASS" \
    -v "$(pwd)":/repo \
    postgres:17 \
    psql "$CONN" -f "/repo/$sql_file"
done

echo "Migrations successfully applied!"
