# Supabase Storage policy hardening

`storage.objects` is owned by Supabase's `supabase_storage_admin`. The project's
`postgres` migration connection is neither the owner nor a member of that role,
so do not run `ALTER TABLE`, `DROP POLICY`, or `CREATE POLICY` for this table via
the repository migration runner. RLS is already enabled in production.

Use **Supabase Dashboard → Storage → Policies → OBJECTS** to edit the existing
`receipt owner or officer read` policy for `payment-receipts`. Keep it as a
permissive `SELECT` policy for `authenticated`, and replace its `USING`
expression with:

```sql
bucket_id = 'payment-receipts'
and public.password_changed()
and (
  public.current_role() = 'admin'::public.app_role
  or exists (
    select 1
    from public.payments p
    join public.registrations r on r.id = p.registration_id
    where p.receipt_path = objects.name
      and r.member_id = auth.uid()
  )
)
```

Keep the existing `member upload own receipt path` INSERT policy; it limits
uploads to the authenticated member's own folder. Do not add UPDATE or DELETE
policies for `payment-receipts`.

The live `receipts_deny_clients` policy is **RESTRICTIVE**, not permissive. Do
not delete it based on its name. Its predicate is about the bucket literally
named `receipts`; for `payment-receipts` it evaluates true and does not grant
access by itself. The live `hs-payment-proofs` bucket has a separate
admin-only SELECT policy, and `hs-offering-images` has an intentional public
read policy; preserve those policies.

After editing, verify in `pg_policies` that the receipt SELECT policy is
PERMISSIVE, targets only `authenticated`, and has the owner-or-admin condition
above. Confirm there are no other permissive SELECT/ALL policies whose
predicate matches `payment-receipts`.
