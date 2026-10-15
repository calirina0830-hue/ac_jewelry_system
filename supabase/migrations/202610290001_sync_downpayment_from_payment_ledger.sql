begin;

-- This migration previously synchronized reservation.downpayment from the
-- payment ledger. Downpayment is now a separate reservation value; the
-- forward migration 202610300001 removes any previously installed sync logic.

commit;
