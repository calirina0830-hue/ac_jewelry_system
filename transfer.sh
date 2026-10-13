#!/usr/bin/env bash
set -e

echo "=================================================="
echo "    Supabase Data Transfer: Old -> New Project    "
echo "=================================================="
echo ""
echo "Old Project: yultgjgbyzopirwatpnh (ap-southeast-2 - Sydney)"
echo "New Project: fvtolirchlcnqpvhxiiw (us-east-1 - Virginia)"
echo ""

DUMP_FILE="prepared_import.sql"

if [ ! -f "$DUMP_FILE" ]; then
  echo "Error: prepared_import.sql not found."
  exit 1
fi

# Prompt for new database password
read -s -p "Enter NEW database password: " NEW_PASS
echo ""

if [ -z "$NEW_PASS" ]; then
  echo "Error: New database password cannot be empty."
  exit 1
fi

echo ""
echo "==> Importing all data into NEW Supabase (us-east-1)..."
echo "Target file: $DUMP_FILE"
echo ""

docker run --rm \
  -e PGPASSWORD="$NEW_PASS" \
  -v "$(pwd)":/dump \
  postgres:17 \
  psql \
    "host=aws-0-us-east-1.pooler.supabase.com port=5432 user=postgres.fvtolirchlcnqpvhxiiw dbname=postgres sslmode=require" \
    -f "/dump/$DUMP_FILE"

echo ""
echo "=================================================="
echo "Data transfer completed successfully!"
echo "=================================================="
