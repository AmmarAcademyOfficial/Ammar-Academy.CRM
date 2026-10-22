-- ===== Accounting plan · Phase 4 · 22 Oct 2026 =====
-- Teaching sessions and hours. Support schedules sessions for a teacher assignment (a private
-- customer or a group course), then records each one: done (with the real hours), cancelled by
-- the student (late or in time), cancelled by the teacher, or no-show.
--   * Paid hours (for the teacher) and student hours (from the package) are worked out when the
--     session is recorded, from the rules in Settings at that moment, and stored with it: a later
--     change to the rules never rewrites past sessions. Defaults (approved plan, question 5):
--     a late student cancellation (< 6 hours before) and a no-show are paid and use package hours.
--   * Private packages: course sessions × hours per session = hours bought; support is notified
--     once when 2 hours or fewer are left.
-- Who: managers, and support for their own customers and for group courses. Sales see their
-- customers' sessions. Accountants see everything (for salaries in phase 5).
-- Additive: one new table, three settings, functions.

alter table public.app_settings add column if not exists late_cancel_hours integer not null default 6;
alter table public.app_settings add column if not exists late_cancel_paid boolean not null default true;
alter table public.app_settings add column if not exists no_show_paid boolean not null default true;
alter table public.app_settings drop constraint if exists app_settings_late_cancel_hours_check;
alter table public.app_settings add constraint app_settings_late_cancel_hours_check check (late_cancel_hours between 0 and 72);

alter table public.enrollments add column if not exists package_low_notified_at timestamptz;

create table if not exists public.teacher_sessions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.teacher_assignments (id),
  teacher_id uuid not null references public.teachers (id),
  rate_id uuid not null references public.teacher_rates (id),
  enrollment_id uuid references public.enrollments (id) on delete cascade,
  course_id uuid references public.courses (id),
  starts_at timestamptz not null,
  planned_hours numeric(4, 2) not null check (planned_hours between 0.25 and 12),
  status text not null default 'scheduled' check (status in ('scheduled', 'done', 'cancelled_student', 'cancelled_teacher', 'no_show')),
  hours numeric(4, 2) check (hours is null or hours between 0 and 12),
  late_cancel boolean not null default false,
  paid_hours numeric(4, 2) not null default 0,
  student_hours numeric(4, 2) not null default 0,
  note text check (note is null or length(note) <= 300),
  recorded_by uuid references public.profiles (id),
  recorded_at timestamptz,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((enrollment_id is null) <> (course_id is null))
);
create index if not exists teacher_sessions_starts_idx on public.teacher_sessions (starts_at);
create index if not exists teacher_sessions_teacher_idx on public.teacher_sessions (teacher_id, starts_at);
create index if not exists teacher_sessions_enrollment_idx on public.teacher_sessions (enrollment_id, starts_at) where enrollment_id is not null;

alter table public.teacher_sessions enable row level security;
revoke all on public.teacher_sessions from anon, authenticated;
grant select on public.teacher_sessions to authenticated;
drop policy if exists session_read on public.teacher_sessions;
create policy session_read on public.teacher_sessions for select to authenticated
  using ((select private.my_role()) in ('manager', 'accountant')
         or (course_id is not null and (select private.my_role()) in ('support', 'sales'))
         or exists (select 1 from public.enrollments e where e.id = teacher_sessions.enrollment_id));

alter table public.activities drop constraint activities_type_check;
alter table public.activities add constraint activities_type_check check (type in (
  'comment', 'contact_attempt', 'stage_change', 'owner_change', 'follow_up_created', 'follow_up_completed',
  'payment_submitted', 'payment_decision', 'handover', 'checklist', 'support_status', 'tag_change',
  'do_not_contact', 'imported', 'resubmitted', 'outreach_shortcut', 'field_change', 'reservation',
  'enrollment', 'support_assignment', 'support_follow_up', 'payment_plan', 'teacher', 'session'
));

insert into public.notification_rules (event, role, enabled, popup) values
  ('package_low', 'support', true, true),
  ('package_low', 'manager', true, false)
on conflict (event, role) do nothing;

-- Fix: money text kept no decimals (1,234.50 showed as "1,235 EGP") because of the "##" pattern.
-- Used only in notification, timeline and message wording; stored amounts were always exact.
create or replace function private.money(p_amount numeric, p_currency text) returns text
language sql immutable set search_path = '' as $$
  select rtrim(rtrim(to_char(p_amount, 'FM999,999,990.00'), '0'), '.') || ' ' || p_currency
$$;

-- Hours as people write them: 1.5, 2, 0.25.
create or replace function private.hours_text(p numeric) returns text
language sql immutable set search_path = '' as $$
  select case when p is null then null else rtrim(rtrim(p::text, '0'), '.') end
$$;

-- May the signed-in person schedule or record sessions of this assignment?
create or replace function private.can_run_sessions(a public.teacher_assignments) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_role public.app_role := private.my_role();
begin
  if v_role = 'manager' then return true; end if;
  if v_role <> 'support' then return false; end if;
  if a.course_id is not null then return true; end if; -- group courses: the support team
  return private.is_support_owner((select inquiry_id from public.enrollments where id = a.enrollment_id));
end $$;

-- Hours bought in a private package (course sessions × hours per session), or null.
create or replace function private.package_hours(p_enrollment uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select c.sessions_count * c.session_hours from public.enrollments e join public.courses c on c.id = e.course_id
   where e.id = p_enrollment and c.sessions_count is not null and c.session_hours is not null
$$;

create or replace function private.package_used(p_enrollment uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(student_hours), 0) from public.teacher_sessions where enrollment_id = p_enrollment
$$;

-- Schedule one session, or a weekly series. p: assignment_id, starts_at, planned_hours, note, repeat_weeks (0–25)
create or replace function public.schedule_sessions(p jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  a public.teacher_assignments;
  v_start timestamptz := nullif(p ->> 'starts_at', '')::timestamptz;
  v_hours numeric := nullif(p ->> 'planned_hours', '')::numeric;
  v_repeat integer := coalesce(nullif(p ->> 'repeat_weeks', '')::integer, 0);
  v_inquiry uuid;
  i integer;
begin
  perform private.require_role('manager', 'support');
  select * into a from public.teacher_assignments where id = (p ->> 'assignment_id')::uuid;
  if not found then raise exception using errcode = 'CRM04', message = 'Teacher assignment not found.'; end if;
  if not private.can_run_sessions(a) then raise exception using errcode = 'CRM04', message = 'This customer is not assigned to you.'; end if;
  if a.ended_on is not null and (v_start at time zone 'Africa/Cairo')::date > a.ended_on then
    perform private.fail('This teacher stopped teaching here on ' || to_char(a.ended_on, 'FMDD Mon YYYY') || '.');
  end if;
  if v_start is null then perform private.fail('Choose the date and time of the session.'); end if;
  if (v_start at time zone 'Africa/Cairo')::date < a.started_on then perform private.fail('The session is before this teacher started.'); end if;
  if v_hours is null or v_hours < 0.25 or v_hours > 12 then perform private.fail('Enter the session length in hours (0.25 to 12).'); end if;
  if v_repeat < 0 or v_repeat > 25 then perform private.fail('Repeat for at most 25 more weeks.'); end if;
  if exists (select 1 from public.teacher_sessions x where x.assignment_id = a.id
             and x.starts_at in (select v_start + make_interval(days => 7 * g) from generate_series(0, v_repeat) g)) then
    perform private.fail('There is already a session with this teacher at that time.');
  end if;
  for i in 0 .. v_repeat loop
    insert into public.teacher_sessions (assignment_id, teacher_id, rate_id, enrollment_id, course_id, starts_at, planned_hours, note, created_by)
    values (a.id, a.teacher_id, a.rate_id, a.enrollment_id, a.course_id, v_start + make_interval(days => 7 * i), v_hours, nullif(trim(p ->> 'note'), ''), auth.uid());
  end loop;
  if a.enrollment_id is not null then
    select inquiry_id into v_inquiry from public.enrollments where id = a.enrollment_id;
    perform private.log_activity(v_inquiry, 'session',
      format('%s scheduled with %s: %s%s', case when v_repeat = 0 then 'Session' else (v_repeat + 1) || ' weekly sessions' end,
             (select full_name from public.teachers where id = a.teacher_id),
             to_char(v_start at time zone 'Africa/Cairo', 'Dy FMDD Mon, FMHH12:MI AM'), case when v_repeat > 0 then ' onwards' else '' end),
      jsonb_build_object('assignment_id', a.id, 'count', v_repeat + 1));
  end if;
  return v_repeat + 1;
end $$;

-- Record what happened. p: id, status, hours (done), late (cancelled_student), note, starts_at?, planned_hours?
create or replace function public.record_session(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.teacher_sessions;
  a public.teacher_assignments;
  st public.app_settings;
  v_status text := p ->> 'status';
  v_hours numeric := nullif(p ->> 'hours', '')::numeric;
  v_late boolean := coalesce((p ->> 'late')::boolean, false);
  v_paid numeric;
  v_student numeric;
  v_inquiry uuid;
  v_bought numeric;
  v_left numeric;
  v_owner uuid;
begin
  perform private.require_role('manager', 'support');
  select * into s from public.teacher_sessions where id = (p ->> 'id')::uuid for update;
  if not found then raise exception using errcode = 'CRM04', message = 'Session not found.'; end if;
  select * into a from public.teacher_assignments where id = s.assignment_id;
  if not private.can_run_sessions(a) then raise exception using errcode = 'CRM04', message = 'This customer is not assigned to you.'; end if;
  select * into st from public.app_settings where id = 1;

  -- Moving a session (time or length) is allowed while it is still scheduled.
  if nullif(p ->> 'starts_at', '') is not null then s.starts_at := (p ->> 'starts_at')::timestamptz; end if;
  if nullif(p ->> 'planned_hours', '') is not null then s.planned_hours := (p ->> 'planned_hours')::numeric; end if;
  if s.planned_hours < 0.25 or s.planned_hours > 12 then perform private.fail('Enter the session length in hours (0.25 to 12).'); end if;

  if v_status not in ('scheduled', 'done', 'cancelled_student', 'cancelled_teacher', 'no_show') then perform private.fail('Choose what happened.'); end if;
  if v_status <> 'scheduled' and s.starts_at > now() + interval '1 hour' then
    perform private.fail('This session has not happened yet. Record it after it takes place.');
  end if;
  if v_status = 'done' then
    v_hours := coalesce(v_hours, s.planned_hours);
    if v_hours <= 0 or v_hours > 12 then perform private.fail('Enter the hours taught (up to 12).'); end if;
  else
    v_hours := null;
  end if;

  v_paid := case v_status
    when 'done' then v_hours
    when 'cancelled_student' then case when v_late and st.late_cancel_paid then s.planned_hours else 0 end
    when 'no_show' then case when st.no_show_paid then s.planned_hours else 0 end
    else 0 end;
  v_student := case v_status
    when 'done' then v_hours
    when 'cancelled_student' then case when v_late and st.late_cancel_paid then s.planned_hours else 0 end
    when 'no_show' then case when st.no_show_paid then s.planned_hours else 0 end
    else 0 end;

  update public.teacher_sessions set
    starts_at = s.starts_at, planned_hours = s.planned_hours, status = v_status, hours = v_hours,
    late_cancel = (v_status = 'cancelled_student' and v_late), paid_hours = v_paid, student_hours = v_student,
    note = coalesce(nullif(trim(p ->> 'note'), ''), note),
    recorded_by = case when v_status = 'scheduled' then null else auth.uid() end,
    recorded_at = case when v_status = 'scheduled' then null else now() end,
    updated_at = now()
  where id = s.id;

  if s.enrollment_id is not null and v_status <> 'scheduled' then
    select inquiry_id into v_inquiry from public.enrollments where id = s.enrollment_id;
    perform private.log_activity(v_inquiry, 'session',
      format('Session %s: %s, %s%s', to_char(s.starts_at at time zone 'Africa/Cairo', 'FMDD Mon'),
             case v_status when 'done' then 'done' when 'cancelled_student' then case when v_late then 'cancelled late by the student' else 'cancelled by the student' end
                           when 'cancelled_teacher' then 'cancelled by the teacher' else 'student did not attend' end,
             (select full_name from public.teachers where id = s.teacher_id),
             case when v_paid > 0 then format(' · %s h paid', private.hours_text(v_paid)) else '' end),
      jsonb_build_object('session_id', s.id, 'status', v_status, 'paid_hours', v_paid));

    -- Package almost used up: tell the support owner once.
    v_bought := private.package_hours(s.enrollment_id);
    if v_bought is not null then
      v_left := v_bought - private.package_used(s.enrollment_id);
      if v_left <= 2 and (select package_low_notified_at from public.enrollments where id = s.enrollment_id) is null then
        select o.support_owner_id into v_owner from public.onboardings o where o.enrollment_id = s.enrollment_id;
        insert into public.notifications (user_id, text, inquiry_id, kind)
        select u.id, format('Package almost used: %s has %s of %s hours left.', private.contact_name(v_inquiry),
                            private.hours_text(greatest(v_left, 0)), private.hours_text(v_bought)), v_inquiry, 'package_low'
          from public.profiles u where u.active and (u.id = v_owner or u.role = 'manager');
        update public.enrollments set package_low_notified_at = now() where id = s.enrollment_id;
      end if;
    end if;
  end if;
  return jsonb_build_object('paid_hours', v_paid, 'student_hours', v_student);
end $$;

-- Remove a session that was scheduled by mistake (recorded sessions stay; managers can remove any).
create or replace function public.delete_session(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  s public.teacher_sessions;
  a public.teacher_assignments;
begin
  perform private.require_role('manager', 'support');
  select * into s from public.teacher_sessions where id = p_id;
  if not found then raise exception using errcode = 'CRM04', message = 'Session not found.'; end if;
  select * into a from public.teacher_assignments where id = s.assignment_id;
  if not private.can_run_sessions(a) then raise exception using errcode = 'CRM04', message = 'This customer is not assigned to you.'; end if;
  if s.status <> 'scheduled' and private.my_role() <> 'manager' then
    perform private.fail('A recorded session can only be removed by a manager. Change what happened instead.');
  end if;
  delete from public.teacher_sessions where id = p_id;
end $$;

-- Sessions between two Cairo dates that the signed-in person may see, with names (no phone numbers).
create or replace function public.sessions_view(p_from date, p_to date)
returns table (id uuid, assignment_id uuid, teacher_id uuid, rate_id uuid, enrollment_id uuid, course_id uuid, inquiry_id uuid,
               customer_name text, support_owner_id uuid, starts_at timestamptz, planned_hours numeric, status text, hours numeric,
               late_cancel boolean, paid_hours numeric, student_hours numeric, note text, recorded_by uuid, recorded_at timestamptz, subject text)
language plpgsql stable security definer set search_path = '' as $$
declare v_role public.app_role := private.require_role('manager', 'support', 'accountant');
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then perform private.fail('Choose a valid date range (at most 400 days).'); end if;
  return query
    select s.id, s.assignment_id, s.teacher_id, s.rate_id, s.enrollment_id, s.course_id, e.inquiry_id, c.name, o.support_owner_id,
           s.starts_at, s.planned_hours, s.status, s.hours, s.late_cancel, s.paid_hours, s.student_hours, s.note, s.recorded_by, s.recorded_at, a.subject
      from public.teacher_sessions s
      join public.teacher_assignments a on a.id = s.assignment_id
      left join public.enrollments e on e.id = s.enrollment_id
      left join public.inquiries i on i.id = e.inquiry_id
      left join public.contacts c on c.id = i.contact_id
      left join public.onboardings o on o.enrollment_id = s.enrollment_id
     where (s.starts_at at time zone 'Africa/Cairo')::date between p_from and p_to
       and (v_role in ('manager', 'accountant') or s.course_id is not null or o.support_owner_id = auth.uid())
     order by s.starts_at;
end $$;

-- ── Settings: three more values ──────────────────────────────────────────
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
    late_cancel_hours = coalesce((p ->> 'late_cancel_hours')::integer, late_cancel_hours),
    late_cancel_paid = coalesce((p ->> 'late_cancel_paid')::boolean, late_cancel_paid),
    no_show_paid = coalesce((p ->> 'no_show_paid')::boolean, no_show_paid),
    handover_trigger = coalesce(p ->> 'handover_trigger', handover_trigger),
    deposit_rule = coalesce(p -> 'deposit_rule', deposit_rule),
    updated_at = now()
  where id = 1;
  perform private.audit('Changed settings', 'Settings', p);
exception
  when check_violation then perform private.fail('One of the values is outside the allowed range.');
end $$;

revoke all on function public.schedule_sessions(jsonb), public.record_session(jsonb), public.delete_session(uuid), public.sessions_view(date, date) from public, anon;
grant execute on function public.schedule_sessions(jsonb), public.record_session(jsonb), public.delete_session(uuid), public.sessions_view(date, date) to authenticated;
revoke all on function private.can_run_sessions(public.teacher_assignments), private.package_hours(uuid), private.package_used(uuid) from public, anon, authenticated;
