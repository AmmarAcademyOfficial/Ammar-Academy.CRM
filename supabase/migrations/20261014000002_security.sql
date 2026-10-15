-- Ammar Academy CRM · Phase 2 · security
--
-- Model:
--   * Signed-in staff use the "authenticated" role. They can only SELECT, and
--     row-level security decides which rows they see (lists, search, counts,
--     custom field values).
--   * Every change goes through a SECURITY DEFINER function in
--     20261014000003_functions.sql that checks the caller's role and ownership.
--     Staff have no direct INSERT/UPDATE/DELETE on business tables.
--   * Personal tables (saved views, column preferences, own notifications)
--     allow direct writes limited to the owner's rows.
--   * "anon" (not signed in) gets nothing.

-- ── Helpers ──────────────────────────────────────────────────────────────

-- Role of the signed-in user, or null when not signed in or deactivated.
create or replace function private.my_role() returns public.app_role
language sql stable security definer set search_path = '' as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.active
$$;

create or replace function private.is_manager() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.my_role() = 'manager', false)
$$;

-- Whether the signed-in user may see an inquiry (and everything attached to it).
-- Phase 4 adds: support staff for customers handed over to support.
create or replace function private.can_see_inquiry(p_inquiry uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.inquiries i
    where i.id = p_inquiry
      and (
        private.my_role() = 'manager'
        or (private.my_role() = 'sales' and i.sales_owner_id = auth.uid())
      )
  )
$$;

-- Sales owner or manager: may work on (change) an inquiry.
create or replace function private.can_work_inquiry(p_inquiry uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_see_inquiry(p_inquiry)
$$;

grant usage on schema private to authenticated;
revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;

-- ── Guard: never lose the last active manager ───────────────────────────
create or replace function private.protect_last_manager() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'manager' and old.active
     and (new.role <> 'manager' or not new.active)
     and not exists (
       select 1 from public.profiles p
       where p.role = 'manager' and p.active and p.id <> old.id
     )
  then
    raise exception using
      errcode = 'CRM01',
      message = case when not new.active
        then 'You cannot deactivate the last active manager.'
        else 'You cannot demote the last active manager.' end;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger profiles_protect_last_manager
  before update on public.profiles
  for each row execute function private.protect_last_manager();

-- ── Privileges ───────────────────────────────────────────────────────────
-- Remove the broad defaults Supabase grants on new public objects.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on
  public.profiles, public.programs, public.cohorts, public.stages, public.contact_outcomes,
  public.tags, public.app_settings, public.contacts, public.inquiries, public.inquiry_tags,
  public.activities, public.note_revisions, public.follow_ups, public.field_definitions,
  public.field_options, public.field_values, public.audit_log
to authenticated;

grant select, insert, update, delete on public.saved_views, public.user_preferences to authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

-- ── Row-level security ───────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.programs enable row level security;
alter table public.cohorts enable row level security;
alter table public.stages enable row level security;
alter table public.contact_outcomes enable row level security;
alter table public.tags enable row level security;
alter table public.app_settings enable row level security;
alter table public.contacts enable row level security;
alter table public.inquiries enable row level security;
alter table public.inquiry_tags enable row level security;
alter table public.activities enable row level security;
alter table public.note_revisions enable row level security;
alter table public.follow_ups enable row level security;
alter table public.field_definitions enable row level security;
alter table public.field_options enable row level security;
alter table public.field_values enable row level security;
alter table public.saved_views enable row level security;
alter table public.user_preferences enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_log enable row level security;

-- Staff directory and reference data: any active staff member.
create policy staff_read on public.profiles for select to authenticated
  using ((select private.my_role()) is not null);
create policy staff_read on public.programs for select to authenticated
  using ((select private.my_role()) is not null);
create policy staff_read on public.cohorts for select to authenticated
  using ((select private.my_role()) is not null);
create policy staff_read on public.stages for select to authenticated
  using ((select private.my_role()) is not null);
create policy staff_read on public.contact_outcomes for select to authenticated
  using ((select private.my_role()) is not null);
create policy staff_read on public.tags for select to authenticated
  using ((select private.my_role()) is not null);
create policy staff_read on public.app_settings for select to authenticated
  using ((select private.my_role()) is not null);
create policy staff_read on public.field_definitions for select to authenticated
  using ((select private.my_role()) is not null);
create policy staff_read on public.field_options for select to authenticated
  using ((select private.my_role()) is not null);

-- Inquiries: managers see all; sales agents see only their own.
create policy inquiry_read on public.inquiries for select to authenticated
  using (
    (select private.my_role()) = 'manager'
    or ((select private.my_role()) = 'sales' and sales_owner_id = (select auth.uid()))
  );

-- Contacts: visible when the viewer can see at least one of the contact's inquiries.
create policy contact_read on public.contacts for select to authenticated
  using (
    (select private.my_role()) = 'manager'
    or exists (select 1 from public.inquiries i where i.contact_id = contacts.id)
  );

create policy inquiry_child_read on public.inquiry_tags for select to authenticated
  using (private.can_see_inquiry(inquiry_id));
create policy inquiry_child_read on public.activities for select to authenticated
  using (private.can_see_inquiry(inquiry_id));
create policy inquiry_child_read on public.follow_ups for select to authenticated
  using (private.can_see_inquiry(inquiry_id));
create policy note_revision_read on public.note_revisions for select to authenticated
  using (exists (select 1 from public.activities a where a.id = note_revisions.activity_id));

-- Custom field values: visible inquiry AND the field is visible to the viewer's role.
create policy field_value_read on public.field_values for select to authenticated
  using (
    private.can_see_inquiry(inquiry_id)
    and exists (
      select 1 from public.field_definitions f
      where f.id = field_values.field_id and (select private.my_role()) = any (f.visible_to)
    )
  );

-- Personal data: own rows only.
create policy own_rows on public.saved_views for all to authenticated
  using (user_id = (select auth.uid()) and (select private.my_role()) is not null)
  with check (user_id = (select auth.uid()) and (select private.my_role()) is not null);
create policy own_rows on public.user_preferences for all to authenticated
  using (user_id = (select auth.uid()) and (select private.my_role()) is not null)
  with check (user_id = (select auth.uid()) and (select private.my_role()) is not null);
create policy own_rows on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy own_rows_mark_read on public.notifications for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Audit history: managers only.
create policy manager_read on public.audit_log for select to authenticated
  using ((select private.is_manager()));
