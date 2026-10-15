-- Ammar Academy CRM · Phase 4 · courses catalog
--
-- Managers keep a catalog of courses: each belongs to a program, has a course
-- type (Group, Private 1:1, Intensive…), a price and details. Any lead
-- (inquiry) can be linked to a course of its program, and lists can be
-- filtered by course and course type. Payments (next migration) use the
-- course price as the default agreed total.
--
-- The Phase 2 "cohorts" table becomes "courses"; existing rows are kept.

-- ── Course types ─────────────────────────────────────────────────────────

create table public.course_types (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 60),
  description text check (description is null or length(description) <= 300),
  color text not null default 'blue' check (color in ('orange', 'blue', 'purple', 'red', 'green', 'teal', 'gray')),
  sort integer not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index course_types_name_unique on public.course_types (lower(name));

-- ── Courses (formerly cohorts) ───────────────────────────────────────────

alter table public.cohorts rename to courses;
alter table public.courses rename column default_price to price;
alter table public.courses
  add column course_type_id uuid references public.course_types (id),
  add column description text check (description is null or length(description) <= 2000),
  add column delivery text not null default 'online' check (delivery in ('online', 'in_person', 'hybrid')),
  add column duration_weeks integer check (duration_weeks is null or duration_weeks between 1 and 104),
  add column sessions_count integer check (sessions_count is null or sessions_count between 1 and 500),
  add column session_hours numeric(4, 1) check (session_hours is null or session_hours between 0.5 and 12),
  add column schedule text check (schedule is null or length(schedule) <= 200),
  add column end_date date,
  add column capacity integer check (capacity is null or capacity between 1 and 1000),
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now(),
  add constraint courses_price_check check (price is null or price >= 0),
  add constraint courses_dates_check check (end_date is null or start_date is null or end_date >= start_date),
  add constraint courses_name_check check (length(trim(name)) between 1 and 120);
create index courses_program_idx on public.courses (program_id, active);

-- A lead's course of interest (must belong to the lead's program; checked in the functions).
alter table public.inquiries add column course_id uuid references public.courses (id);
create index inquiries_course_idx on public.inquiries (course_id);

-- ── Security ─────────────────────────────────────────────────────────────
-- courses keeps its Phase 2 grants and "staff_read" policy through the rename.

alter table public.course_types enable row level security;
revoke all on public.course_types from anon, authenticated;
grant select on public.course_types to authenticated;
create policy staff_read on public.course_types for select to authenticated
  using ((select private.my_role()) is not null);

-- ── Manager functions ────────────────────────────────────────────────────

drop function if exists public.save_cohort(jsonb);

-- p: id?, name, description, color
create or replace function public.save_course_type(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  perform private.require_role('manager');
  if coalesce(trim(p ->> 'name'), '') = '' then perform private.fail('Name the course type.'); end if;
  if exists (select 1 from public.course_types where lower(name) = lower(trim(p ->> 'name')) and id is distinct from v_id) then
    perform private.fail('A course type with this name already exists.');
  end if;
  if v_id is null then
    insert into public.course_types (name, description, color, sort)
    values (trim(p ->> 'name'), nullif(trim(p ->> 'description'), ''), coalesce(nullif(p ->> 'color', ''), 'blue'),
            coalesce((select max(sort) + 1 from public.course_types), 1))
    returning id into v_id;
    perform private.audit('Added course type', trim(p ->> 'name'));
  else
    update public.course_types set name = trim(p ->> 'name'), description = nullif(trim(p ->> 'description'), ''),
      color = coalesce(nullif(p ->> 'color', ''), color)
    where id = v_id;
    if not found then raise exception using errcode = 'CRM04', message = 'Course type not found.'; end if;
    perform private.audit('Updated course type', trim(p ->> 'name'));
  end if;
  return v_id;
end $$;

create or replace function public.set_course_type_archived(p_id uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  perform private.require_role('manager');
  update public.course_types set archived = p_archived where id = p_id returning name into v_name;
  if v_name is null then raise exception using errcode = 'CRM04', message = 'Course type not found.'; end if;
  perform private.audit(case when p_archived then 'Archived course type' else 'Restored course type' end, v_name);
end $$;

-- p: id?, program_id, course_type_id, name, price, currency, description, delivery,
--    duration_weeks, sessions_count, session_hours, schedule, start_date, end_date, capacity, active
create or replace function public.save_course(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_old public.courses;
  v_price numeric := nullif(p ->> 'price', '')::numeric;
  v_currency text := upper(coalesce(nullif(p ->> 'currency', ''), 'EGP'));
  v_type uuid := nullif(p ->> 'course_type_id', '')::uuid;
  v_program uuid := (p ->> 'program_id')::uuid;
begin
  perform private.require_role('manager');
  if coalesce(trim(p ->> 'name'), '') = '' then perform private.fail('Name the course.'); end if;
  if not exists (select 1 from public.programs where id = v_program) then perform private.fail('Choose the program.'); end if;
  if v_type is null or not exists (select 1 from public.course_types where id = v_type) then
    perform private.fail('Choose the course type.');
  end if;
  if v_price is not null and v_price < 0 then perform private.fail('The price cannot be negative.'); end if;
  if v_currency !~ '^[A-Z]{3}$' then perform private.fail('Use a 3-letter currency code, for example EGP.'); end if;
  if nullif(p ->> 'end_date', '') is not null and nullif(p ->> 'start_date', '') is not null
     and (p ->> 'end_date')::date < (p ->> 'start_date')::date then
    perform private.fail('The end date is before the start date.');
  end if;

  if v_id is null then
    insert into public.courses (program_id, course_type_id, name, price, currency, description, delivery, duration_weeks,
      sessions_count, session_hours, schedule, start_date, end_date, capacity, active)
    values (v_program, v_type, trim(p ->> 'name'), v_price, v_currency, nullif(trim(p ->> 'description'), ''),
      coalesce(nullif(p ->> 'delivery', ''), 'online'), nullif(p ->> 'duration_weeks', '')::integer,
      nullif(p ->> 'sessions_count', '')::integer, nullif(p ->> 'session_hours', '')::numeric,
      nullif(trim(p ->> 'schedule'), ''), nullif(p ->> 'start_date', '')::date, nullif(p ->> 'end_date', '')::date,
      nullif(p ->> 'capacity', '')::integer, coalesce((p ->> 'active')::boolean, true))
    returning id into v_id;
    perform private.audit('Added course', trim(p ->> 'name'), jsonb_build_object('price', v_price, 'currency', v_currency));
  else
    select * into v_old from public.courses where id = v_id for update;
    if not found then raise exception using errcode = 'CRM04', message = 'Course not found.'; end if;
    if v_old.program_id <> v_program and exists (select 1 from public.inquiries where course_id = v_id) then
      perform private.fail('This course is already linked to leads, so its program cannot change. Create a new course instead.');
    end if;
    update public.courses set program_id = v_program, course_type_id = v_type, name = trim(p ->> 'name'), price = v_price,
      currency = v_currency, description = nullif(trim(p ->> 'description'), ''), delivery = coalesce(nullif(p ->> 'delivery', ''), 'online'),
      duration_weeks = nullif(p ->> 'duration_weeks', '')::integer, sessions_count = nullif(p ->> 'sessions_count', '')::integer,
      session_hours = nullif(p ->> 'session_hours', '')::numeric, schedule = nullif(trim(p ->> 'schedule'), ''),
      start_date = nullif(p ->> 'start_date', '')::date, end_date = nullif(p ->> 'end_date', '')::date,
      capacity = nullif(p ->> 'capacity', '')::integer, active = coalesce((p ->> 'active')::boolean, active), updated_at = now()
    where id = v_id;
    -- Price changes are kept in the audit history. Agreed totals of existing enrollments never change.
    perform private.audit(
      case when v_old.price is distinct from v_price
        then format('Updated course · price %s → %s %s', coalesce(v_old.price::text, '—'), coalesce(v_price::text, '—'), v_currency)
        else 'Updated course' end,
      trim(p ->> 'name'));
  end if;
  return v_id;
end $$;

create or replace function public.set_course_active(p_id uuid, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  perform private.require_role('manager');
  update public.courses set active = p_active, updated_at = now() where id = p_id returning name into v_name;
  if v_name is null then raise exception using errcode = 'CRM04', message = 'Course not found.'; end if;
  perform private.audit(case when p_active then 'Reopened course' else 'Closed course for new leads' end, v_name);
end $$;

-- Links a lead to a course of its program (null clears). Owner agent or manager.
create or replace function public.set_inquiry_course(p_inquiry uuid, p_course uuid, p_expected_version integer default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  q public.inquiries := private.inquiry_for_work(p_inquiry);
  c public.courses;
begin
  perform private.check_version(q, p_expected_version);
  if p_course is not null then
    select * into c from public.courses where id = p_course;
    if not found then perform private.fail('Course not found.'); end if;
    if c.program_id <> q.program_id then perform private.fail('This course belongs to another program.'); end if;
    if not c.active and q.course_id is distinct from p_course then perform private.fail('This course is closed for new leads.'); end if;
  end if;
  if q.course_id is not distinct from p_course then return q.version; end if;
  update public.inquiries set course_id = p_course, version = version + 1 where id = p_inquiry;
  perform private.log_activity(p_inquiry, 'field_change',
    case when p_course is null then 'Course cleared' else 'Course: ' || c.name end,
    jsonb_build_object('course_id', p_course));
  return q.version + 1;
end $$;

grant execute on function public.save_course_type(jsonb), public.set_course_type_archived(uuid, boolean), public.save_course(jsonb),
  public.set_course_active(uuid, boolean), public.set_inquiry_course(uuid, uuid, integer) to authenticated;
revoke execute on function public.save_course_type(jsonb), public.set_course_type_archived(uuid, boolean), public.save_course(jsonb),
  public.set_course_active(uuid, boolean), public.set_inquiry_course(uuid, uuid, integer) from public, anon;

-- ── Reference data ───────────────────────────────────────────────────────
-- Starter course types; managers rename, add or archive them in Settings.
insert into public.course_types (name, description, color, sort) values
  ('Group course', 'Live classes with a group of students', 'blue', 1),
  ('Private 1:1', 'One student with one teacher', 'purple', 2),
  ('Intensive', 'Short, high-frequency course before an exam date', 'orange', 3),
  ('Mock exams', 'Practice tests with feedback', 'teal', 4)
on conflict do nothing;
-- Existing courses (from Phase 2 cohorts) get the first type so every course has one.
update public.courses set course_type_id = (select id from public.course_types order by sort limit 1) where course_type_id is null;
