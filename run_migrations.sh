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
  supabase/migrations/202610210001_delete_archived_reservations.sql
do
  echo "Applying $sql_file..."
  docker run --rm \
    -e PGPASSWORD="$DB_PASS" \
    -v "$(pwd)":/repo \
    postgres:17 \
    psql "$CONN" -f "/repo/$sql_file"
done

echo "Migrations successfully applied!"
