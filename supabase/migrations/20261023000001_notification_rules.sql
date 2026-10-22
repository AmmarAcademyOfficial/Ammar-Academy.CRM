-- ===== Step 2 · 22 Oct 2026 =====
-- Notification settings:
--   1. Every notification gets a type ("kind"). Managers choose, per type and per role, whether it
--      is sent at all and whether it pops up with a sound. One trigger on public.notifications
--      applies the rules, so every existing sender is covered without changing it.
--   2. Managers get a notification for each new lead.
--   3. "Not opened yet" alert: the owner (and managers) are told when an assigned lead has not been
--      opened after N minutes (Settings; 0 = off).
--   4. Follow-up reminders are actually sent now (the setting existed, nothing sent them).
-- Additive and backward compatible with the step 1 code.

-- ── Columns ───────────────────────────────────────────────────────────────
alter table public.notifications add column if not exists kind text;
alter table public.notifications add column if not exists popup boolean not null default false;

alter table public.app_settings add column if not exists unopened_alert_minutes integer not null default 30;
alter table public.app_settings drop constraint if exists app_settings_unopened_alert_minutes_check;
alter table public.app_settings add constraint app_settings_unopened_alert_minutes_check
  check (unopened_alert_minutes between 0 and 1440);

alter table public.inquiries add column if not exists unopened_alert_at timestamptz;
alter table public.follow_ups add column if not exists reminded_at timestamptz;
alter table public.support_follow_ups add column if not exists reminded_at timestamptz;

-- Nothing old gets a late reminder: anything already due counts as reminded.
update public.follow_ups set reminded_at = now() where reminded_at is null and due_at <= now() + interval '15 minutes';
update public.support_follow_ups set reminded_at = now() where reminded_at is null and due_at <= now() + interval '15 minutes';
-- Leads that are already waiting do not all alert at once on the first run.
update public.inquiries set unopened_alert_at = now()
 where unopened_alert_at is null and sales_owner_id is not null and owner_opened_at is null;

-- ── Rules ─────────────────────────────────────────────────────────────────
create table if not exists public.notification_rules (
  event text not null,
  role public.app_role not null,
  enabled boolean not null default true,
  popup boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (event, role)
);

insert into public.notification_rules (event, role, enabled, popup) values
  ('lead_assigned', 'sales', true, true),
  ('returning_customer', 'sales', true, true),
  ('form_resubmitted', 'sales', true, true),
  ('lead_not_opened', 'sales', true, true),
  ('followup_due', 'sales', true, true),
  ('followup_due', 'support', true, true),
  ('payment_update', 'sales', true, true),
  ('payment_update', 'support', true, true),
  ('handed_over', 'sales', true, false),
  ('support_assigned', 'support', true, true),
  ('new_customer_ready', 'support', true, true),
  ('customer_flagged', 'support', true, true),
  ('customer_flagged', 'manager', true, true),
  ('new_lead', 'manager', true, true),
  ('lead_not_opened_manager', 'manager', true, true),
  ('payment_to_review', 'manager', true, true),
  ('no_agent_on_shift', 'manager', true, true),
  ('previous_agent_inactive', 'manager', true, false),
  ('sheet_problem', 'manager', true, true)
on conflict (event, role) do nothing;

alter table public.notification_rules enable row level security;
revoke all on public.notification_rules from anon, authenticated;
grant select on public.notification_rules to authenticated;
drop policy if exists staff_read on public.notification_rules;
create policy staff_read on public.notification_rules for select to authenticated
  using ((select private.my_role()) is not null);

-- The type of a notification from its text, for senders written before types existed.
create or replace function private.notification_kind(p_text text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_text like 'New lead assigned: %' or p_text like 'Lead assigned to you: %' or p_text like 'Lead reassigned to you: %' then 'lead_assigned'
    when p_text like 'Returning customer assigned to you:%' then 'returning_customer'
    when p_text like 'Returning customer %' then 'previous_agent_inactive'
    when p_text like 'Submitted the form again: %' then 'form_resubmitted'
    when p_text like 'Enrolled and handed over to support: %' then 'handed_over'
    when p_text like 'Payment to review: %' then 'payment_to_review'
    when p_text like 'Payment %' then 'payment_update'
    when p_text like 'Customer assigned to you for onboarding: %' then 'support_assigned'
    when p_text like 'New customer ready for onboarding: %' then 'new_customer_ready'
    when p_text like 'Handed-over customer flagged%' then 'customer_flagged'
    when p_text like '% waiting: no sales agent is on shift for %' then 'no_agent_on_shift'
    when p_text like 'Google Sheet % needs attention:%' or p_text like 'Google Sheets stopped syncing%' then 'sheet_problem'
    else 'other'
  end
$$;

-- Applies the rules to every new notification: drops it when switched off for the recipient's
-- role, and marks whether it pops up. Types without a rule are always sent, without a pop-up.
create or replace function private.apply_notification_rule()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_role public.app_role;
  r record;
begin
  new.kind := coalesce(new.kind, private.notification_kind(new.text));
  select role into v_role from public.profiles where id = new.user_id;
  select enabled, popup into r from public.notification_rules where event = new.kind and role = v_role;
  if found then
    if not r.enabled then return null; end if;
    new.popup := r.popup;
  else
    new.popup := false;
  end if;
  return new;
end $$;
drop trigger if exists notifications_apply_rule on public.notifications;
create trigger notifications_apply_rule before insert on public.notifications
  for each row execute function private.apply_notification_rule();

-- Existing notifications get their type (for the record; they never pop up).
update public.notifications set kind = private.notification_kind(text) where kind is null;

create or replace function public.set_notification_rule(p_event text, p_role public.app_role, p_enabled boolean, p_popup boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_role('manager');
  update public.notification_rules set enabled = p_enabled, popup = p_popup, updated_at = now()
   where event = p_event and role = p_role;
  if not found then perform private.fail('That notification setting does not exist.'); end if;
  perform private.audit('Changed notification setting', 'Notifications',
    jsonb_build_object('event', p_event, 'role', p_role, 'enabled', p_enabled, 'popup', p_popup));
end $$;

-- ── Settings: one more value ─────────────────────────────────────────────
create or replace function public.update_settings(p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_role('manager');
  update public.app_settings set
    agents_can_create_tags = coalesce((p ->> 'agents_can_create_tags')::boolean, agents_can_create_tags),
    agents_can_pause = coalesce((p ->> 'agents_can_pause')::boolean, agents_can_pause),
    per_agent_lead_cap_enabled = coalesce((p ->> 'per_agent_lead_cap_enabled')::boolean, per_agent_lead_cap_enabled),
    reminder_minutes_before = coalesce((p ->> 'reminder_minutes_before')::integer, reminder_minutes_before),
    overdue_after_minutes = coalesce((p ->> 'overdue_after_minutes')::integer, overdue_after_minutes),
    first_contact_target_minutes = coalesce((p ->> 'first_contact_target_minutes')::integer, first_contact_target_minutes),
    note_edit_window_minutes = coalesce((p ->> 'note_edit_window_minutes')::integer, note_edit_window_minutes),
    unopened_alert_minutes = coalesce((p ->> 'unopened_alert_minutes')::integer, unopened_alert_minutes),
    handover_trigger = coalesce(p ->> 'handover_trigger', handover_trigger),
    deposit_rule = coalesce(p -> 'deposit_rule', deposit_rule),
    updated_at = now()
  where id = 1;
  perform private.audit('Changed settings', 'Settings', p);
exception
  when check_violation then perform private.fail('One of the values is outside the allowed range.');
end $$;

-- ── Managers: a notification for each new lead ───────────────────────────
-- Only for leads that arrived in the last day (a first sync of an old sheet stays quiet), and
-- not to the manager who typed the lead in themselves.
create or replace function private.notify_new_lead()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_program text;
begin
  if new.created_at < now() - interval '1 day' then return null; end if;
  select c.name into v_name from public.contacts c where c.id = new.contact_id;
  select coalesce(p.code, p.name) into v_program from public.programs p where p.id = new.program_id;
  insert into public.notifications (user_id, text, inquiry_id, kind)
  select m.id,
         format('New lead: %s (%s%s)', v_name, v_program,
                case when new.source = 'google_sheet' then ', Google Sheet' else ', added manually' end),
         new.id, 'new_lead'
    from public.profiles m
   where m.role = 'manager' and m.active
     and m.id is distinct from new.created_by;
  return null;
end $$;
drop trigger if exists inquiries_notify_new_lead on public.inquiries;
create trigger inquiries_notify_new_lead after insert on public.inquiries
  for each row execute function private.notify_new_lead();

-- ── A new owner: the not-opened alert can fire again ─────────────────────
create or replace function private.reset_owner_opened()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.sales_owner_id is distinct from old.sales_owner_id then
    new.owner_opened_at := case when new.sales_owner_id is not null and new.sales_owner_id = auth.uid() then now() end;
    new.unopened_alert_at := null;
  end if;
  return new;
end $$;

-- A follow-up moved to a new time gets a new reminder.
create or replace function private.reset_followup_reminder()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.due_at is distinct from old.due_at then new.reminded_at := null; end if;
  return new;
end $$;
drop trigger if exists follow_ups_reset_reminder on public.follow_ups;
create trigger follow_ups_reset_reminder before update of due_at on public.follow_ups
  for each row execute function private.reset_followup_reminder();
drop trigger if exists support_follow_ups_reset_reminder on public.support_follow_ups;
create trigger support_follow_ups_reset_reminder before update of due_at on public.support_follow_ups
  for each row execute function private.reset_followup_reminder();

-- ── Timed alerts (run by the 2-minute scheduler) ─────────────────────────
create or replace function private.send_timed_alerts(p_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  st public.app_settings;
  rec record;
  v_unopened integer := 0;
  v_reminders integer := 0;
begin
  select * into st from public.app_settings where id = 1;

  -- 1. Leads not opened N minutes after they were assigned (only assignments from the last day).
  if st.unopened_alert_minutes > 0 then
    for rec in
      select i.id, i.sales_owner_id, c.name, p.full_name as agent
        from public.inquiries i
        join public.stages s on s.id = i.stage_id
        join public.contacts c on c.id = i.contact_id
        join public.profiles p on p.id = i.sales_owner_id
       where i.sales_owner_id is not null and i.owner_opened_at is null and i.unopened_alert_at is null
         and not s.is_closed
         and i.assigned_at <= p_at - make_interval(mins => st.unopened_alert_minutes)
         and i.assigned_at > p_at - interval '1 day'
       for update of i skip locked
    loop
      insert into public.notifications (user_id, text, inquiry_id, kind)
      values (rec.sales_owner_id,
              format('Not opened yet: %s was assigned to you %s minutes ago.', rec.name, st.unopened_alert_minutes),
              rec.id, 'lead_not_opened');
      insert into public.notifications (user_id, text, inquiry_id, kind)
      select m.id, format('Not opened for %s minutes: %s (%s).', st.unopened_alert_minutes, rec.name, rec.agent), rec.id, 'lead_not_opened_manager'
        from public.profiles m where m.role = 'manager' and m.active;
      update public.inquiries set unopened_alert_at = p_at where id = rec.id;
      v_unopened := v_unopened + 1;
    end loop;
  end if;

  -- 2. Follow-up reminders, N minutes before the due time (0 = at the due time).
  --    Nothing more than 2 hours overdue is reminded (for example after downtime).
  for rec in
    select f.id, f.owner_id, f.inquiry_id, f.due_at, f.note, c.name
      from public.follow_ups f
      join public.inquiries i on i.id = f.inquiry_id
      join public.contacts c on c.id = i.contact_id
     where f.status = 'open' and f.reminded_at is null
       and f.due_at - make_interval(mins => st.reminder_minutes_before) <= p_at
       and f.due_at > p_at - interval '2 hours'
     for update of f skip locked
  loop
    insert into public.notifications (user_id, text, inquiry_id, kind)
    values (rec.owner_id,
            format('Follow-up due %s: %s · %s',
                   case when rec.due_at <= p_at then 'now' else 'at ' || to_char(rec.due_at at time zone 'Africa/Cairo', 'FMHH12:MI AM') end,
                   rec.name, rec.note),
            rec.inquiry_id, 'followup_due');
    update public.follow_ups set reminded_at = p_at where id = rec.id;
    v_reminders := v_reminders + 1;
  end loop;

  for rec in
    select f.id, f.owner_id, e.inquiry_id, f.due_at, f.note, c.name
      from public.support_follow_ups f
      join public.onboardings o on o.id = f.onboarding_id
      join public.enrollments e on e.id = o.enrollment_id
      join public.inquiries i on i.id = e.inquiry_id
      join public.contacts c on c.id = i.contact_id
     where f.status = 'open' and f.reminded_at is null and f.owner_id is not null
       and f.due_at - make_interval(mins => st.reminder_minutes_before) <= p_at
       and f.due_at > p_at - interval '2 hours'
     for update of f skip locked
  loop
    insert into public.notifications (user_id, text, inquiry_id, kind)
    values (rec.owner_id,
            format('Follow-up due %s: %s · %s',
                   case when rec.due_at <= p_at then 'now' else 'at ' || to_char(rec.due_at at time zone 'Africa/Cairo', 'FMHH12:MI AM') end,
                   rec.name, rec.note),
            rec.inquiry_id, 'followup_due');
    update public.support_follow_ups set reminded_at = p_at where id = rec.id;
    v_reminders := v_reminders + 1;
  end loop;

  return jsonb_build_object('unopened', v_unopened, 'reminders', v_reminders);
end $$;

-- ── Access ────────────────────────────────────────────────────────────────
revoke all on function public.set_notification_rule(text, public.app_role, boolean, boolean) from public, anon;
grant execute on function public.set_notification_rule(text, public.app_role, boolean, boolean) to authenticated;
revoke all on function private.send_timed_alerts(timestamptz) from public, anon, authenticated;
revoke all on function private.notification_kind(text) from public, anon;
