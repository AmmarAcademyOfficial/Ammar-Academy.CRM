-- ===== Accounting plan · Phase 3 · 22 Oct 2026 =====
-- Teachers, their hourly rates and who they teach. Teachers do not sign in (records, not logins).
--   * teachers: name, contact, programs taught, active.
--   * teacher_rates: named rates per teacher ("SAT private", "IELTS group") in one currency;
--     archived, never deleted. teacher_rate_amounts: the amount per hour from a date, so a change
--     never rewrites the past (phase 5 counts each hour at the amount valid on its date).
--   * teacher_assignments: a teacher + rate for a private customer (enrollment) or a group course.
-- Who: managers manage teachers and rates; managers and accountants see amounts; everyone sees
-- teacher names and rate names. Managers and the customer's support owner assign private teachers;
-- managers assign group teachers.
-- Additive: new tables and functions only.

create table if not exists public.teachers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (length(trim(full_name)) between 1 and 120),
  phone text check (phone is null or length(phone) <= 40),
  email text check (email is null or length(email) <= 200),
  program_ids uuid[] not null default '{}',
  active boolean not null default true,
  notes text check (notes is null or length(notes) <= 1000),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists teachers_name_unique on public.teachers (lower(full_name));

create table if not exists public.teacher_rates (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  currency text not null default 'EGP' check (currency ~ '^[A-Z]{3}$'),
  archived boolean not null default false,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create unique index if not exists teacher_rates_name_unique on public.teacher_rates (teacher_id, lower(name));

create table if not exists public.teacher_rate_amounts (
  id uuid primary key default gen_random_uuid(),
  rate_id uuid not null references public.teacher_rates (id) on delete cascade,
  amount numeric(10, 2) not null check (amount > 0 and amount <= 100000),
  valid_from date not null,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (rate_id, valid_from)
);

create table if not exists public.teacher_assignments (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers (id),
  rate_id uuid not null references public.teacher_rates (id),
  enrollment_id uuid references public.enrollments (id) on delete cascade,
  course_id uuid references public.courses (id),
  subject text check (subject is null or length(subject) <= 60),
  started_on date not null,
  ended_on date,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  check ((enrollment_id is null) <> (course_id is null)),
  check (ended_on is null or ended_on >= started_on)
);
create index if not exists teacher_assignments_teacher_idx on public.teacher_assignments (teacher_id);
create index if not exists teacher_assignments_enrollment_idx on public.teacher_assignments (enrollment_id) where enrollment_id is not null;
create index if not exists teacher_assignments_course_idx on public.teacher_assignments (course_id) where course_id is not null;

-- ── Access ────────────────────────────────────────────────────────────────
alter table public.teachers enable row level security;
alter table public.teacher_rates enable row level security;
alter table public.teacher_rate_amounts enable row level security;
alter table public.teacher_assignments enable row level security;
revoke all on public.teachers, public.teacher_rates, public.teacher_rate_amounts, public.teacher_assignments from anon, authenticated;
grant select on public.teachers, public.teacher_rates, public.teacher_rate_amounts, public.teacher_assignments to authenticated;

drop policy if exists staff_read on public.teachers;
create policy staff_read on public.teachers for select to authenticated using ((select private.my_role()) is not null);
drop policy if exists staff_read on public.teacher_rates;
create policy staff_read on public.teacher_rates for select to authenticated using ((select private.my_role()) is not null);
-- Amounts: managers and accountants only.
drop policy if exists finance_read on public.teacher_rate_amounts;
create policy finance_read on public.teacher_rate_amounts for select to authenticated
  using ((select private.my_role()) in ('manager', 'accountant'));
-- Assignments: group courses for all staff; private ones for whoever can see the enrollment, and finance.
drop policy if exists assignment_read on public.teacher_assignments;
create policy assignment_read on public.teacher_assignments for select to authenticated
  using ((select private.my_role()) in ('manager', 'accountant')
         or (course_id is not null and (select private.my_role()) is not null)
         or exists (select 1 from public.enrollments e where e.id = teacher_assignments.enrollment_id));

-- The amount per hour of a rate on a given day (null before its first amount).
create or replace function private.rate_amount_on(p_rate uuid, p_day date) returns numeric
language sql stable security definer set search_path = '' as $$
  select a.amount from public.teacher_rate_amounts a
   where a.rate_id = p_rate and a.valid_from <= p_day order by a.valid_from desc limit 1
$$;

-- ── Teachers (managers) ──────────────────────────────────────────────────
-- p: id?, full_name, phone, email, program_ids[], active, notes
create or replace function public.save_teacher(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_name text := trim(coalesce(p ->> 'full_name', ''));
  v_programs uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p -> 'program_ids', '[]')) x), '{}');
begin
  perform private.require_role('manager');
  if v_name = '' then perform private.fail('Enter the teacher''s name.'); end if;
  if exists (select 1 from unnest(v_programs) g where not exists (select 1 from public.programs pr where pr.id = g)) then
    perform private.fail('Choose programs from the list.');
  end if;
  if exists (select 1 from public.teachers t where lower(t.full_name) = lower(v_name) and t.id is distinct from v_id) then
    perform private.fail('A teacher with this name already exists.');
  end if;
  if v_id is null then
    insert into public.teachers (full_name, phone, email, program_ids, active, notes, created_by)
    values (v_name, nullif(trim(p ->> 'phone'), ''), nullif(trim(p ->> 'email'), ''), v_programs,
            coalesce((p ->> 'active')::boolean, true), nullif(trim(p ->> 'notes'), ''), auth.uid())
    returning id into v_id;
    perform private.audit('Added teacher', v_name);
  else
    update public.teachers set full_name = v_name, phone = nullif(trim(p ->> 'phone'), ''), email = nullif(trim(p ->> 'email'), ''),
      program_ids = v_programs, active = coalesce((p ->> 'active')::boolean, active), notes = nullif(trim(p ->> 'notes'), ''), updated_at = now()
    where id = v_id;
    if not found then raise exception using errcode = 'CRM04', message = 'Teacher not found.'; end if;
    perform private.audit('Updated teacher', v_name);
  end if;
  return v_id;
exception
  when check_violation then perform private.fail('One of the values is too long.');
end $$;

-- A new rate with its first amount. p: teacher_id, name, currency, amount, valid_from
create or replace function public.add_teacher_rate(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_teacher text;
  v_amount numeric := nullif(p ->> 'amount', '')::numeric;
  v_from date := coalesce(nullif(p ->> 'valid_from', '')::date, (now() at time zone 'Africa/Cairo')::date);
  v_name text := trim(coalesce(p ->> 'name', ''));
  v_cur text := upper(coalesce(nullif(trim(p ->> 'currency'), ''), 'EGP'));
begin
  perform private.require_role('manager');
  select full_name into v_teacher from public.teachers where id = (p ->> 'teacher_id')::uuid;
  if v_teacher is null then raise exception using errcode = 'CRM04', message = 'Teacher not found.'; end if;
  if v_name = '' then perform private.fail('Name the rate, for example "SAT private".'); end if;
  if v_amount is null or v_amount <= 0 or v_amount > 100000 then perform private.fail('Enter the amount per hour.'); end if;
  if v_cur !~ '^[A-Z]{3}$' then perform private.fail('Use a 3-letter currency code.'); end if;
  if exists (select 1 from public.teacher_rates r where r.teacher_id = (p ->> 'teacher_id')::uuid and lower(r.name) = lower(v_name)) then
    perform private.fail('This teacher already has a rate with this name. Change its amount instead.');
  end if;
  insert into public.teacher_rates (teacher_id, name, currency, created_by) values ((p ->> 'teacher_id')::uuid, v_name, v_cur, auth.uid()) returning id into v_id;
  insert into public.teacher_rate_amounts (rate_id, amount, valid_from, created_by) values (v_id, v_amount, v_from, auth.uid());
  perform private.audit(format('Added rate %s: %s per hour from %s', v_name, private.money(v_amount, v_cur), to_char(v_from, 'FMDD Mon YYYY')), v_teacher);
  return v_id;
end $$;

-- A new amount from a date (the old one keeps counting before it). Same date = correct that amount.
create or replace function public.set_teacher_rate_amount(p_rate uuid, p_amount numeric, p_valid_from date)
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  perform private.require_role('manager');
  select tr.*, t.full_name into r from public.teacher_rates tr join public.teachers t on t.id = tr.teacher_id where tr.id = p_rate;
  if not found then raise exception using errcode = 'CRM04', message = 'Rate not found.'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000 then perform private.fail('Enter the amount per hour.'); end if;
  if p_valid_from is null then perform private.fail('Choose the date the new amount starts.'); end if;
  insert into public.teacher_rate_amounts (rate_id, amount, valid_from, created_by) values (p_rate, p_amount, p_valid_from, auth.uid())
  on conflict (rate_id, valid_from) do update set amount = excluded.amount, created_by = excluded.created_by, created_at = now();
  perform private.audit(format('Rate %s: %s per hour from %s', r.name, private.money(p_amount, r.currency), to_char(p_valid_from, 'FMDD Mon YYYY')), r.full_name);
end $$;

create or replace function public.set_teacher_rate_archived(p_rate uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  perform private.require_role('manager');
  update public.teacher_rates set archived = p_archived where id = p_rate returning name, teacher_id into r;
  if r is null then raise exception using errcode = 'CRM04', message = 'Rate not found.'; end if;
  perform private.audit(format('%s rate %s', case when p_archived then 'Archived' else 'Restored' end, r.name),
                        (select full_name from public.teachers where id = r.teacher_id));
end $$;

-- ── Assignments ──────────────────────────────────────────────────────────
-- p: teacher_id, rate_id, enrollment_id | course_id, subject, started_on
create or replace function public.assign_teacher(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  t public.teachers;
  r public.teacher_rates;
  e public.enrollments;
  v_course uuid := nullif(p ->> 'course_id', '')::uuid;
  v_enr uuid := nullif(p ->> 'enrollment_id', '')::uuid;
  v_start date := coalesce(nullif(p ->> 'started_on', '')::date, (now() at time zone 'Africa/Cairo')::date);
  v_subject text := nullif(trim(p ->> 'subject'), '');
  v_id uuid;
  v_label text;
  v_inquiry uuid;
begin
  perform private.require_role('manager', 'support');
  select * into t from public.teachers where id = (p ->> 'teacher_id')::uuid;
  if not found then raise exception using errcode = 'CRM04', message = 'Teacher not found.'; end if;
  if not t.active then perform private.fail(t.full_name || ' is not an active teacher.'); end if;
  select * into r from public.teacher_rates where id = (p ->> 'rate_id')::uuid;
  if not found or r.teacher_id <> t.id then perform private.fail('Choose one of this teacher''s rates.'); end if;
  if r.archived then perform private.fail('This rate is archived. Choose a current rate.'); end if;
  if (v_course is null) = (v_enr is null) then perform private.fail('Choose a customer or a group course.'); end if;
  if v_start < (now() at time zone 'Africa/Cairo')::date - 120 then perform private.fail('The start date is more than 4 months ago.'); end if;

  if v_enr is not null then
    select * into e from public.enrollments where id = v_enr;
    if not found then raise exception using errcode = 'CRM04', message = 'Customer not found.'; end if;
    if private.my_role() = 'support' and not private.is_support_owner(e.inquiry_id) then
      raise exception using errcode = 'CRM04', message = 'This customer is not assigned to you.';
    end if;
    if exists (select 1 from public.teacher_assignments a where a.enrollment_id = v_enr and a.teacher_id = t.id and a.ended_on is null
               and coalesce(a.subject, '') = coalesce(v_subject, '')) then
      perform private.fail(t.full_name || ' already teaches this customer' || coalesce(' (' || v_subject || ')', '') || '.');
    end if;
    v_inquiry := e.inquiry_id;
  else
    perform private.require_role('manager');
    if not exists (select 1 from public.courses where id = v_course) then raise exception using errcode = 'CRM04', message = 'Course not found.'; end if;
    if exists (select 1 from public.teacher_assignments a where a.course_id = v_course and a.teacher_id = t.id and a.ended_on is null
               and coalesce(a.subject, '') = coalesce(v_subject, '')) then
      perform private.fail(t.full_name || ' already teaches this group' || coalesce(' (' || v_subject || ')', '') || '.');
    end if;
  end if;

  insert into public.teacher_assignments (teacher_id, rate_id, enrollment_id, course_id, subject, started_on, created_by)
  values (t.id, r.id, v_enr, v_course, v_subject, v_start, auth.uid()) returning id into v_id;
  v_label := format('Teacher: %s%s (%s) from %s', t.full_name, coalesce(' · ' || v_subject, ''), r.name, to_char(v_start, 'FMDD Mon YYYY'));
  if v_inquiry is not null then
    perform private.log_activity(v_inquiry, 'teacher', v_label, jsonb_build_object('assignment_id', v_id, 'teacher_id', t.id));
  else
    perform private.audit(v_label, (select name from public.courses where id = v_course));
  end if;
  return v_id;
end $$;

-- Stop an assignment from a date (kept for the record and for salaries).
create or replace function public.end_teacher_assignment(p_id uuid, p_ended_on date default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  a public.teacher_assignments;
  v_inquiry uuid;
  v_end date := coalesce(p_ended_on, (now() at time zone 'Africa/Cairo')::date);
begin
  perform private.require_role('manager', 'support');
  select * into a from public.teacher_assignments where id = p_id for update;
  if not found then raise exception using errcode = 'CRM04', message = 'Assignment not found.'; end if;
  if a.ended_on is not null then perform private.fail('This assignment has already ended.'); end if;
  if v_end < a.started_on then perform private.fail('The end date is before the start date.'); end if;
  if a.enrollment_id is not null then
    select inquiry_id into v_inquiry from public.enrollments where id = a.enrollment_id;
    if private.my_role() = 'support' and not private.is_support_owner(v_inquiry) then
      raise exception using errcode = 'CRM04', message = 'This customer is not assigned to you.';
    end if;
  else
    perform private.require_role('manager');
  end if;
  update public.teacher_assignments set ended_on = v_end where id = p_id;
  if v_inquiry is not null then
    perform private.log_activity(v_inquiry, 'teacher',
      format('Teacher stopped: %s from %s', (select full_name from public.teachers where id = a.teacher_id), to_char(v_end, 'FMDD Mon YYYY')),
      jsonb_build_object('assignment_id', p_id, 'ended', true));
  else
    perform private.audit(format('Teacher stopped: %s from %s', (select full_name from public.teachers where id = a.teacher_id), to_char(v_end, 'FMDD Mon YYYY')),
                          (select name from public.courses where id = a.course_id));
  end if;
end $$;

-- Teacher overview for managers and accountants: every assignment with the customer's name
-- (no phone numbers), for the Teachers settings page and later the salary screens.
create or replace function public.teacher_assignments_view()
returns table (id uuid, teacher_id uuid, rate_id uuid, enrollment_id uuid, course_id uuid, subject text, started_on date, ended_on date,
               customer_name text, inquiry_id uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_role('manager', 'accountant');
  return query
    select a.id, a.teacher_id, a.rate_id, a.enrollment_id, a.course_id, a.subject, a.started_on, a.ended_on, c.name, e.inquiry_id
      from public.teacher_assignments a
      left join public.enrollments e on e.id = a.enrollment_id
      left join public.inquiries i on i.id = e.inquiry_id
      left join public.contacts c on c.id = i.contact_id
     order by a.ended_on nulls first, a.started_on desc;
end $$;

alter table public.activities drop constraint activities_type_check;
alter table public.activities add constraint activities_type_check check (type in (
  'comment', 'contact_attempt', 'stage_change', 'owner_change', 'follow_up_created', 'follow_up_completed',
  'payment_submitted', 'payment_decision', 'handover', 'checklist', 'support_status', 'tag_change',
  'do_not_contact', 'imported', 'resubmitted', 'outreach_shortcut', 'field_change', 'reservation',
  'enrollment', 'support_assignment', 'support_follow_up', 'payment_plan', 'teacher'
));

revoke all on function public.save_teacher(jsonb), public.add_teacher_rate(jsonb), public.set_teacher_rate_amount(uuid, numeric, date),
  public.set_teacher_rate_archived(uuid, boolean), public.assign_teacher(jsonb), public.end_teacher_assignment(uuid, date),
  public.teacher_assignments_view() from public, anon;
grant execute on function public.save_teacher(jsonb), public.add_teacher_rate(jsonb), public.set_teacher_rate_amount(uuid, numeric, date),
  public.set_teacher_rate_archived(uuid, boolean), public.assign_teacher(jsonb), public.end_teacher_assignment(uuid, date),
  public.teacher_assignments_view() to authenticated;
revoke all on function private.rate_amount_on(uuid, date) from public, anon, authenticated;
