begin;

-- Customer text is stored as PostgreSQL text and can contain any Unicode
-- language. Permit a one-character name (for example, a valid single-glyph
-- name) and keep the database limit aligned with the application validator.
alter table public.customers
  drop constraint if exists customers_name_length;

alter table public.customers
  add constraint customers_name_length
  check (char_length(btrim(name)) between 1 and 160);

commit;
