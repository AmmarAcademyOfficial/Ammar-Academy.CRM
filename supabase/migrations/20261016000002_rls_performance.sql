-- Phase 5 · Faster row-level security (same rules, computed once per query)
--
-- The load test (20,000 inquiries, two years of history) showed sales and support screens slowing
-- down because read policies called a permission function for every row. The rules do not change:
--   managers see everything; a sales agent sees inquiries they own; support sees handed-over
--   customers that are unclaimed or their own.
-- Now the set of inquiries a sales or support user may see is computed once per query and rows are
-- matched against it, and managers short-circuit before any per-row work.

-- Inquiry ids the signed-in sales or support user may see (empty for managers and anyone else;
-- managers are allowed by the policies directly).
create or replace function private.my_inquiry_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select i.id from public.inquiries i
  where private.my_role() = 'sales' and i.sales_owner_id = auth.uid()
  union all
  select e.inquiry_id from public.enrollments e join public.onboardings o on o.enrollment_id = e.id
  where private.my_role() = 'support' and (o.support_owner_id is null or o.support_owner_id = auth.uid())
$$;
revoke all on function private.my_inquiry_ids() from public, anon;
grant execute on function private.my_inquiry_ids() to authenticated;

drop policy inquiry_read on public.inquiries;
create policy inquiry_read on public.inquiries for select to authenticated
  using (
    (select private.my_role()) = 'manager'
    or ((select private.my_role()) = 'sales' and sales_owner_id = (select auth.uid()))
    or ((select private.my_role()) = 'support' and id in (select private.my_inquiry_ids()))
  );

drop policy inquiry_child_read on public.activities;
create policy inquiry_child_read on public.activities for select to authenticated
  using ((select private.my_role()) = 'manager' or inquiry_id in (select private.my_inquiry_ids()));

drop policy inquiry_child_read on public.follow_ups;
create policy inquiry_child_read on public.follow_ups for select to authenticated
  using ((select private.my_role()) = 'manager' or inquiry_id in (select private.my_inquiry_ids()));

drop policy inquiry_child_read on public.inquiry_tags;
create policy inquiry_child_read on public.inquiry_tags for select to authenticated
  using ((select private.my_role()) = 'manager' or inquiry_id in (select private.my_inquiry_ids()));

drop policy enrollment_read on public.enrollments;
create policy enrollment_read on public.enrollments for select to authenticated
  using ((select private.my_role()) = 'manager' or inquiry_id in (select private.my_inquiry_ids()));

drop policy field_value_read on public.field_values;
create policy field_value_read on public.field_values for select to authenticated
  using (
    ((select private.my_role()) = 'manager' or inquiry_id in (select private.my_inquiry_ids()))
    and exists (select 1 from public.field_definitions f where f.id = field_values.field_id and (select private.my_role()) = any (f.visible_to))
  );

-- Indexes the support and payment screens lean on.
create index if not exists enrollments_course_idx on public.enrollments (course_id);
create index if not exists onboardings_status_idx on public.onboardings (support_owner_id, status);
create index if not exists payments_decided_idx on public.payments (decided_at desc) where status in ('confirmed', 'rejected', 'reversed');
create index if not exists onboarding_items_open_idx on public.onboarding_items (onboarding_id, due_at) where done_at is null;
create index if not exists activities_lost_idx on public.activities (inquiry_id, created_at) where type = 'stage_change';
create index if not exists inquiries_assigned_idx on public.inquiries (assigned_at) where sales_owner_id is not null;
