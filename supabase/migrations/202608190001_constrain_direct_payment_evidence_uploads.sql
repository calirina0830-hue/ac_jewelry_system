begin;

drop policy if exists "payment_evidence_insert_admin_staff"
  on storage.objects;

create policy "payment_evidence_insert_admin_staff"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'payment-evidence'
  and (select public.current_profile_role()) in ('admin', 'staff')
  and cardinality(string_to_array(name, '/')) = 3
  and (string_to_array(name, '/'))[1] = (select auth.uid()::text)
  and (string_to_array(name, '/'))[2]
    ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and (string_to_array(name, '/'))[3]
    ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$'
);

commit;
