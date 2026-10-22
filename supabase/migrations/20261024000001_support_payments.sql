-- ===== Accounting plan · Phase 1 · 22 Oct 2026 =====
-- Customer support records payments, sets a payment plan, and is told when payments are due or
-- overdue. Builds on the existing payments table and confirmation flow:
--   1. Each payment has a type: deposit, installment or full payment. Existing ones are labelled.
--   2. A customer's support owner may submit payments (same rules and manager confirmation).
--   3. payment_dues: the expected payments (due date + amount). Confirmed payments submitted after
--      the plan was started count toward it, earliest due first. A fully paid enrollment is paid.
--   4. "Payment due soon" and "Payment overdue" notifications from the 2-minute scheduler.
-- Additive: new table, new optional column, new setting; existing totals and handover unchanged.

-- ── 1. Payment type ──────────────────────────────────────────────────────
alter table public.payments add column if not exists kind text;
alter table public.payments drop constraint if exists payments_kind_check;
alter table public.payments add constraint payments_kind_check check (kind is null or kind in ('deposit', 'installment', 'full'));

-- Existing payments: the first one is a deposit (or full payment when it covered the total), later ones installments.
with ranked as (
  select p.id, p.amount, e.agreed_total,
         row_number() over (partition by p.enrollment_id order by p.submitted_at, p.id) as n
    from public.payments p join public.enrollments e on e.id = p.enrollment_id
   where p.kind is null
)
update public.payments p
   set kind = case when r.n = 1 and r.amount >= r.agreed_total then 'full' when r.n = 1 then 'deposit' else 'installment' end
  from ranked r where r.id = p.id;

alter table public.activities drop constraint activities_type_check;
alter table public.activities add constraint activities_type_check check (type in (
  'comment', 'contact_attempt', 'stage_change', 'owner_change', 'follow_up_created', 'follow_up_completed',
  'payment_submitted', 'payment_decision', 'handover', 'checklist', 'support_status', 'tag_change',
  'do_not_contact', 'imported', 'resubmitted', 'outreach_shortcut', 'field_change', 'reservation',
  'enrollment', 'support_assignment', 'support_follow_up', 'payment_plan'
));

-- ── 2. Who may record payments and plans for a customer ─────────────────
-- Managers; the inquiry's sales owner; the customer's support owner (after handover).
create or replace function private.is_support_owner(p_inquiry uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.my_role() = 'support' and exists (
    select 1 from public.enrollments e join public.onboardings o on o.enrollment_id = e.id
     where e.inquiry_id = p_inquiry and o.support_owner_id = auth.uid())
$$;

create or replace function private.inquiry_for_payment(p_inquiry uuid)
returns public.inquiries language plpgsql security definer set search_path = '' as $$
declare q public.inquiries;
begin
  if private.my_role() = 'support' then
    select * into q from public.inquiries where id = p_inquiry for update;
    if not found or not private.is_support_owner(p_inquiry) then
      raise exception using errcode = 'CRM04', message = 'This customer is not assigned to you.';
    end if;
    return q;
  end if;
  return private.inquiry_for_work(p_inquiry);
end $$;

-- p: enrollment_id, amount, paid_on, method, reference, note, kind (deposit | installment | full),
--    receipt: {path, name, mime, size} (verified by the server before it reaches here)
create or replace function public.submit_payment(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  e public.enrollments;
  q public.inquiries;
  t record;
  v_amount numeric := nullif(p ->> 'amount', '')::numeric;
  v_method public.payment_method;
  v_ref text := nullif(trim(p ->> 'reference'), '');
  v_paid_on date := nullif(p ->> 'paid_on', '')::date;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_kind text := nullif(p ->> 'kind', '');
  v_remaining numeric;
  v_id uuid;
begin
  perform private.require_role('manager', 'sales', 'support');
  select * into e from public.enrollments where id = (p ->> 'enrollment_id')::uuid;
  if not found then raise exception using errcode = 'CRM04', message = 'Enrollment not found.'; end if;
  q := private.inquiry_for_payment(e.inquiry_id);
  perform 1 from public.enrollments where id = e.id for update; -- one submission at a time per enrollment

  begin
    v_method := (p ->> 'method')::public.payment_method;
  exception when others then
    perform private.fail('Choose how the customer paid.');
  end;
  if v_method is null then perform private.fail('Choose how the customer paid.'); end if;
  if v_amount is null or v_amount <= 0 then perform private.fail('Enter the amount paid.'); end if;
  if v_paid_on is null then perform private.fail('Enter the payment date.'); end if;
  if v_paid_on > v_today then perform private.fail('The payment date cannot be in the future.'); end if;
  if v_paid_on < v_today - 365 then perform private.fail('The payment date is more than a year ago.'); end if;
  if v_method <> 'cash' and v_ref is null then perform private.fail('Enter the transfer or transaction reference.'); end if;
  if v_method <> 'cash' and nullif(p #>> '{receipt,path}', '') is null then
    perform private.fail('Attach the receipt (a photo or PDF of the transfer).');
  end if;
  select * into t from private.enrollment_totals(e.id);
  v_remaining := t.agreed - t.paid - t.pending;
  if v_amount > v_remaining + 0.005 then
    perform private.fail(format('This is more than the remaining balance (%s, including payments waiting for review). If the price changed, update the agreed total first.',
      private.money(greatest(v_remaining, 0), e.currency)));
  end if;
  -- Type: chosen by the person; filled in when an older screen sends none.
  if v_kind is null then
    v_kind := case when exists (select 1 from public.payments x where x.enrollment_id = e.id and x.status in ('pending', 'confirmed')) then 'installment'
                   when v_amount >= v_remaining - 0.005 then 'full' else 'deposit' end;
  end if;
  if v_kind not in ('deposit', 'installment', 'full') then perform private.fail('Choose the payment type.'); end if;
  if v_kind = 'full' and abs(v_amount - v_remaining) > 0.005 then
    perform private.fail(format('A full payment must be the whole remaining balance (%s). Choose Deposit or Installment for part of it.',
      private.money(greatest(v_remaining, 0), e.currency)));
  end if;
  if v_ref is not null and exists (
    select 1 from public.payments x join public.enrollments ee on ee.id = x.enrollment_id
    where lower(x.reference) = lower(v_ref) and x.method = v_method and x.status in ('pending', 'confirmed')
  ) then
    perform private.fail('A payment with this reference was already submitted. Check it is not a duplicate.');
  end if;

  insert into public.payments (enrollment_id, amount, paid_on, method, reference, note, receipt_path, receipt_name, receipt_mime, receipt_size, submitted_by, kind)
  values (e.id, v_amount, v_paid_on, v_method, v_ref, nullif(trim(p ->> 'note'), ''),
          nullif(p #>> '{receipt,path}', ''), nullif(p #>> '{receipt,name}', ''), nullif(p #>> '{receipt,mime}', ''),
          nullif(p #>> '{receipt,size}', '')::integer, auth.uid(), v_kind)
  returning id into v_id;

  perform private.log_activity(q.id, 'payment_submitted',
    format('Payment submitted (%s): %s · %s%s', case v_kind when 'full' then 'full payment' else v_kind end,
           private.money(v_amount, e.currency), replace(v_method::text, '_', ' '), coalesce(' · ref ' || v_ref, '')),
    jsonb_build_object('payment_id', v_id, 'amount', v_amount, 'kind', v_kind));
  insert into public.notifications (user_id, text, inquiry_id)
  select id, format('Payment to review: %s · %s', private.contact_name(q.id), private.money(v_amount, e.currency)), q.id
  from public.profiles where role = 'manager' and active and id <> auth.uid();
  perform private.ensure_awaiting_payment(q.id);
  return v_id;
end $$;

-- ── 3. Payment plan ──────────────────────────────────────────────────────
create table if not exists public.payment_dues (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments (id) on delete cascade,
  due_on date not null,
  amount numeric(12, 2) not null check (amount > 0),
  note text check (note is null or length(note) <= 300),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  due_soon_notified_at timestamptz,
  overdue_notified_at timestamptz
);
create index if not exists payment_dues_enrollment_idx on public.payment_dues (enrollment_id, due_on);
create index if not exists payment_dues_due_idx on public.payment_dues (due_on);

alter table public.payment_dues enable row level security;
revoke all on public.payment_dues from anon, authenticated;
grant select on public.payment_dues to authenticated;
drop policy if exists payment_due_read on public.payment_dues;
create policy payment_due_read on public.payment_dues for select to authenticated
  using (exists (select 1 from public.enrollments e where e.id = payment_dues.enrollment_id));

-- Every due with what has been paid toward it. Confirmed payments submitted on or after the plan
-- started (its first due's creation) are applied to dues in date order; a fully paid enrollment
-- covers everything. status: paid | partly_paid | upcoming | due_today | overdue.
create or replace function private.dues_state(p_enrollment uuid default null, p_today date default (now() at time zone 'Africa/Cairo')::date)
returns table (id uuid, enrollment_id uuid, inquiry_id uuid, due_on date, amount numeric, covered numeric, status text,
               note text, currency text, due_soon_notified_at timestamptz, overdue_notified_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with d as (
    select pd.*, e.inquiry_id, e.currency, e.agreed_total,
           sum(pd.amount) over (partition by pd.enrollment_id order by pd.due_on, pd.created_at, pd.id) as cum_to,
           min(pd.created_at) over (partition by pd.enrollment_id) as plan_start
      from public.payment_dues pd join public.enrollments e on e.id = pd.enrollment_id
     where p_enrollment is null or pd.enrollment_id = p_enrollment
  ), pools as (
    select x.enrollment_id,
           coalesce(sum(p.amount) filter (where p.status = 'confirmed' and p.submitted_at >= x.plan_start), 0) as pool,
           coalesce(sum(p.amount) filter (where p.status = 'confirmed'), 0) as paid_all
      from (select distinct d.enrollment_id, d.plan_start from d) x
      left join public.payments p on p.enrollment_id = x.enrollment_id
     group by x.enrollment_id
  ), c as (
    select d.*, case when pl.paid_all >= d.agreed_total - 0.005 then d.amount
                     else greatest(0, least(d.amount, pl.pool - (d.cum_to - d.amount))) end as covered
      from d join pools pl on pl.enrollment_id = d.enrollment_id
  )
  select c.id, c.enrollment_id, c.inquiry_id, c.due_on, c.amount, c.covered,
         case when c.covered >= c.amount - 0.005 then 'paid'
              when c.due_on < p_today then 'overdue'
              when c.due_on = p_today then 'due_today'
              when c.covered > 0 then 'partly_paid'
              else 'upcoming' end,
         c.note, c.currency, c.due_soon_notified_at, c.overdue_notified_at
    from c
$$;

-- Read model for the screens: the dues the signed-in person may see.
create or replace function public.payment_dues_view(p_enrollment uuid default null)
returns table (id uuid, enrollment_id uuid, inquiry_id uuid, due_on date, amount numeric, covered numeric, status text, note text, currency text)
language sql stable security definer set search_path = '' as $$
  select s.id, s.enrollment_id, s.inquiry_id, s.due_on, s.amount, s.covered, s.status, s.note, s.currency
    from private.dues_state(p_enrollment) s
   where private.can_see_inquiry(s.inquiry_id)
   order by s.due_on, s.id
$$;

-- p: id? (edit), enrollment_id, due_on, amount, note. Managers and the customer's support owner.
create or replace function public.save_payment_due(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  e public.enrollments;
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_due date := nullif(p ->> 'due_on', '')::date;
  v_amount numeric := nullif(p ->> 'amount', '')::numeric;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  t record;
  v_open numeric;
begin
  perform private.require_role('manager', 'support');
  if v_id is not null then
    select en.* into e from public.payment_dues d join public.enrollments en on en.id = d.enrollment_id where d.id = v_id;
  else
    select * into e from public.enrollments where id = (p ->> 'enrollment_id')::uuid;
  end if;
  if not found then raise exception using errcode = 'CRM04', message = 'Payment plan not found.'; end if;
  perform private.inquiry_for_payment(e.inquiry_id);
  perform 1 from public.enrollments where id = e.id for update;
  if v_due is null then perform private.fail('Enter the due date.'); end if;
  if v_due < v_today - 60 or v_due > v_today + 730 then perform private.fail('The due date must be within 60 days ago and 2 years ahead.'); end if;
  if v_amount is null or v_amount <= 0 then perform private.fail('Enter the amount due.'); end if;

  if v_id is null then
    insert into public.payment_dues (enrollment_id, due_on, amount, note, created_by)
    values (e.id, v_due, v_amount, nullif(trim(p ->> 'note'), ''), auth.uid()) returning id into v_id;
  else
    update public.payment_dues set due_on = v_due, amount = v_amount, note = nullif(trim(p ->> 'note'), ''), updated_at = now() where id = v_id;
  end if;

  -- The unpaid part of the plan cannot be more than the balance left.
  select * into t from private.enrollment_totals(e.id);
  select coalesce(sum(s.amount - s.covered), 0) into v_open from private.dues_state(e.id) s where s.status <> 'paid';
  if v_open > t.agreed - t.paid + 0.005 then
    perform private.fail(format('The planned payments add up to more than the balance left (%s).', private.money(greatest(t.agreed - t.paid, 0), e.currency)));
  end if;

  perform private.log_activity(e.inquiry_id, 'payment_plan',
    format('Payment plan: %s due %s', private.money(v_amount, e.currency), to_char(v_due, 'FMDD Mon YYYY')),
    jsonb_build_object('due_id', v_id, 'due_on', v_due, 'amount', v_amount));
  return v_id;
end $$;

create or replace function public.delete_payment_due(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  d public.payment_dues;
  e public.enrollments;
begin
  perform private.require_role('manager', 'support');
  select * into d from public.payment_dues where id = p_id;
  if not found then raise exception using errcode = 'CRM04', message = 'Payment plan not found.'; end if;
  select * into e from public.enrollments where id = d.enrollment_id;
  perform private.inquiry_for_payment(e.inquiry_id);
  delete from public.payment_dues where id = p_id;
  perform private.log_activity(e.inquiry_id, 'payment_plan',
    format('Removed from the payment plan: %s due %s', private.money(d.amount, e.currency), to_char(d.due_on, 'FMDD Mon YYYY')),
    jsonb_build_object('due_id', p_id, 'removed', true));
end $$;

-- A due moved or changed is reminded again.
create or replace function private.reset_due_notices()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.due_on is distinct from old.due_on or new.amount is distinct from old.amount then
    new.due_soon_notified_at := null;
    new.overdue_notified_at := null;
  end if;
  return new;
end $$;
drop trigger if exists payment_dues_reset_notices on public.payment_dues;
create trigger payment_dues_reset_notices before update of due_on, amount on public.payment_dues
  for each row execute function private.reset_due_notices();

-- ── 4. Notifications ─────────────────────────────────────────────────────
alter table public.app_settings add column if not exists payment_due_soon_days integer not null default 1;
alter table public.app_settings drop constraint if exists app_settings_payment_due_soon_days_check;
alter table public.app_settings add constraint app_settings_payment_due_soon_days_check check (payment_due_soon_days between 0 and 30);

insert into public.notification_rules (event, role, enabled, popup) values
  ('payment_due_soon', 'support', true, false),
  ('payment_due_soon', 'sales', true, false),
  ('payment_overdue', 'support', true, true),
  ('payment_overdue', 'sales', true, true),
  ('payment_overdue', 'manager', true, true)
on conflict (event, role) do nothing;

create or replace function private.notification_kind(p_text text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_text like 'New lead assigned: %' or p_text like 'Lead assigned to you: %' or p_text like 'Lead reassigned to you: %' then 'lead_assigned'
    when p_text like 'Returning customer assigned to you:%' then 'returning_customer'
    when p_text like 'Returning customer %' then 'previous_agent_inactive'
    when p_text like 'Submitted the form again: %' then 'form_resubmitted'
    when p_text like 'Enrolled and handed over to support: %' then 'handed_over'
    when p_text like 'Payment to review: %' then 'payment_to_review'
    when p_text like 'Payment due soon: %' then 'payment_due_soon'
    when p_text like 'Payment overdue: %' then 'payment_overdue'
    when p_text like 'Payment %' then 'payment_update'
    when p_text like 'Customer assigned to you for onboarding: %' then 'support_assigned'
    when p_text like 'New customer ready for onboarding: %' then 'new_customer_ready'
    when p_text like 'Handed-over customer flagged%' then 'customer_flagged'
    when p_text like '% waiting: no sales agent is on shift for %' then 'no_agent_on_shift'
    when p_text like 'Google Sheet % needs attention:%' or p_text like 'Google Sheets stopped syncing%' then 'sheet_problem'
    else 'other'
  end
$$;

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
    payment_due_soon_days = coalesce((p ->> 'payment_due_soon_days')::integer, payment_due_soon_days),
    handover_trigger = coalesce(p ->> 'handover_trigger', handover_trigger),
    deposit_rule = coalesce(p -> 'deposit_rule', deposit_rule),
    updated_at = now()
  where id = 1;
  perform private.audit('Changed settings', 'Settings', p);
exception
  when check_violation then perform private.fail('One of the values is outside the allowed range.');
end $$;

-- Who hears about a customer's payments: their support owner after handover, else the sales owner.
create or replace function private.payment_contact(p_inquiry uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select o.support_owner_id from public.enrollments e join public.onboardings o on o.enrollment_id = e.id
      join public.profiles pr on pr.id = o.support_owner_id
      where e.inquiry_id = p_inquiry and pr.active),
    (select i.sales_owner_id from public.inquiries i join public.profiles pr on pr.id = i.sales_owner_id
      where i.id = p_inquiry and pr.active))
$$;

-- The 2-minute scheduler's timed alerts: step 2's two, plus payment plan alerts (from 9:00 Cairo time).
create or replace function private.send_timed_alerts(p_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  st public.app_settings;
  rec record;
  v_unopened integer := 0;
  v_reminders integer := 0;
  v_due_soon integer := 0;
  v_overdue integer := 0;
  v_today date := (p_at at time zone 'Africa/Cairo')::date;
  v_contact uuid;
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

  -- 3. Payment plan: due soon (once) and overdue (the day after, then weekly), from 9:00 Cairo time.
  if extract(hour from p_at at time zone 'Africa/Cairo') >= 9 then
    if st.payment_due_soon_days > 0 then
      for rec in
        select s.id, s.inquiry_id, s.due_on, s.amount - s.covered as left_due, s.currency, c.name
          from private.dues_state(null, v_today) s
          join public.inquiries i on i.id = s.inquiry_id
          join public.contacts c on c.id = i.contact_id
         where s.status in ('upcoming', 'partly_paid', 'due_today') and s.due_soon_notified_at is null
           and s.due_on - st.payment_due_soon_days <= v_today and s.due_on >= v_today
      loop
        v_contact := private.payment_contact(rec.inquiry_id);
        if v_contact is not null then
          insert into public.notifications (user_id, text, inquiry_id, kind)
          values (v_contact, format('Payment due soon: %s · %s due %s.', rec.name, private.money(rec.left_due, rec.currency),
                                    case when rec.due_on = v_today then 'today' else to_char(rec.due_on, 'FMDD Mon') end),
                  rec.inquiry_id, 'payment_due_soon');
        end if;
        update public.payment_dues set due_soon_notified_at = p_at where id = rec.id;
        v_due_soon := v_due_soon + 1;
      end loop;
    end if;

    for rec in
      select s.id, s.inquiry_id, s.due_on, s.amount - s.covered as left_due, s.currency, c.name
        from private.dues_state(null, v_today) s
        join public.inquiries i on i.id = s.inquiry_id
        join public.contacts c on c.id = i.contact_id
       where s.status = 'overdue'
         and (s.overdue_notified_at is null or s.overdue_notified_at <= p_at - interval '7 days')
    loop
      v_contact := private.payment_contact(rec.inquiry_id);
      insert into public.notifications (user_id, text, inquiry_id, kind)
      select u.id, format('Payment overdue: %s · %s was due %s (%s days ago).', rec.name, private.money(rec.left_due, rec.currency),
                          to_char(rec.due_on, 'FMDD Mon'), v_today - rec.due_on),
             rec.inquiry_id, 'payment_overdue'
        from public.profiles u
       where u.active and (u.id = v_contact or u.role = 'manager');
      update public.payment_dues set overdue_notified_at = p_at where id = rec.id;
      v_overdue := v_overdue + 1;
    end loop;
  end if;

  return jsonb_build_object('unopened', v_unopened, 'reminders', v_reminders, 'payments_due_soon', v_due_soon, 'payments_overdue', v_overdue);
end $$;

-- ── Access ────────────────────────────────────────────────────────────────
revoke all on function public.payment_dues_view(uuid) from public, anon;
grant execute on function public.payment_dues_view(uuid) to authenticated;
revoke all on function public.save_payment_due(jsonb) from public, anon;
grant execute on function public.save_payment_due(jsonb) to authenticated;
revoke all on function public.delete_payment_due(uuid) from public, anon;
grant execute on function public.delete_payment_due(uuid) to authenticated;
revoke all on function private.dues_state(uuid, date) from public, anon, authenticated;
revoke all on function private.payment_contact(uuid) from public, anon, authenticated;
