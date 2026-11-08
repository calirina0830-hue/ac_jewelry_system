#!/usr/bin/env bash
set -e

echo "Setting up adminrina (calisittieasia@gmail.com)..."

read -s -p "Enter NEW database password: " NEW_PASS
echo ""

if [ -z "$NEW_PASS" ]; then
  echo "Error: Password cannot be empty."
  exit 1
fi

read -s -p "Enter the password to set for adminrina: " ADMIN_PASS
echo ""

if [ -z "$ADMIN_PASS" ]; then
  echo "Error: Admin password cannot be empty."
  exit 1
fi

docker run --rm \
  -e PGPASSWORD="$NEW_PASS" \
  -v "$(pwd)":/dump \
  postgres:17 \
  psql \
    "host=aws-0-us-east-1.pooler.supabase.com port=5432 user=postgres.fvtolirchlcnqpvhxiiw dbname=postgres sslmode=require" \
    -v admin_password="$ADMIN_PASS" \
    -f "/dump/create_admin_user.sql"

echo ""
echo "Done! You can now log in with:"
echo "Username: adminrina (or calisittieasia@gmail.com)"
echo "Password: the one you just entered"
