-- Ammar Academy CRM · Phase 3 · shifts and round-robin distribution
--
-- Rules (approved in Phases 0–1):
--   * A new inquiry goes to the next eligible sales agent for its program.
--   * Eligible = active sales agent, on a shift that covers this program right
--     now (Cairo time, overnight shifts included), not on leave, not paused,
--     and under their open-lead cap when caps are turned on.
--   * Round-robin per program by a fixed rotation order. Ineligible agents
--     are skipped but keep their place. Manual reassignment never moves the
--     rotation pointer.
--   * With no eligible agent the inquiry waits in the manager-only queue and
--     is assigned on a later run, oldest first.
--   * An inquiry is assigned at most once by the system (guarded by a row lock
--     and "where sales_owner_id is null").
--   * A pause ends automatically when the agent's shift ends.

-- ── Tables ───────────────────────────────────────────────────────────────

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),          -- 0 = Sunday (Cairo)
  start_minute smallint not null check (start_minute between 0 and 1439),
  end_minute smallint not null check (end_minute between 0 and 1439),  -- end <= start = runs past midnight
  program_ids uuid[] not null check (cardinality(program_ids) > 0),
  created_at timestamptz not null default now()
);
create index shifts_user_idx on public.shifts (user_id);

create table public.time_off (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  reason text check (reason is null or length(reason) <= 200),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index time_off_user_idx on public.time_off (user_id, starts_on, ends_on);

-- One row per program: who received the last system assignment.
create table public.rotation_state (
  program_id uuid primary key references public.programs (id) on delete cascade,
  last_user_id uuid references public.profiles (id),
  last_rotation_order integer,
  last_assigned_at timestamptz,
  last_no_agent_alert_at timestamptz
);
insert into public.rotation_state (program_id) select id from public.programs on conflict do nothing;

alter table public.profiles add column paused_at timestamptz;
alter table public.inquiries add column assignment_method text check (assignment_method in ('round_robin', 'manual', 'creator'));

create index inquiries_unassigned_idx on public.inquiries (created_at) where sales_owner_id is null;

-- ── Security ─────────────────────────────────────────────────────────────

alter table public.shifts enable row level security;
alter table public.time_off enable row level security;
alter table public.rotation_state enable row level security;

-- New tables inherit Supabase's broad default grants; start from nothing, then grant reads only.
revoke all on public.shifts, public.time_off, public.rotation_state from anon, authenticated;
grant select on public.shifts, public.time_off, public.rotation_state to authenticated;

-- Managers see everyone's schedule; agents see their own.
create policy shifts_read on public.shifts for select to authenticated
  using (private.is_manager() or user_id = auth.uid());
create policy time_off_read on public.time_off for select to authenticated
  using (private.is_manager() or user_id = auth.uid());
create policy rotation_read on public.rotation_state for select to authenticated
  using (private.is_manager());

-- ── Eligibility ──────────────────────────────────────────────────────────

-- Cairo wall-clock weekday (0 = Sunday) and minute of day.
create or replace function private.cairo_clock(p_at timestamptz, out weekday integer, out minute integer, out day date)
language sql immutable set search_path = '' as $$
  select extract(dow from p_at at time zone 'Africa/Cairo')::integer,
         (extract(hour from p_at at time zone 'Africa/Cairo') * 60 + extract(minute from p_at at time zone 'Africa/Cairo'))::integer,
         (p_at at time zone 'Africa/Cairo')::date
$$;

-- Does this shift cover the moment? An overnight shift starting Monday 22:00
-- covers Monday 22:00–24:00 and Tuesday 00:00–end.
create or replace function private.shift_covers(s public.shifts, p_at timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select case
    when s.end_minute > s.start_minute then
      c.weekday = s.weekday and c.minute >= s.start_minute and c.minute < s.end_minute
    else
      (c.weekday = s.weekday and c.minute >= s.start_minute)
      or (c.weekday = (s.weekday + 1) % 7 and c.minute < s.end_minute)
  end
  from private.cairo_clock(p_at) c
$$;

create or replace function private.open_lead_count(p_user uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::integer from public.inquiries i join public.stages s on s.id = i.stage_id
  where i.sales_owner_id = p_user and not s.is_closed
$$;

-- Why an agent cannot receive a lead for this program right now; null = eligible.
-- Same order of checks as src/domain/rules.ts (ineligibleReason).
create or replace function private.ineligible_reason(p_user uuid, p_program uuid, p_at timestamptz default now())
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  p public.profiles;
  v_cap_on boolean := (select per_agent_lead_cap_enabled from public.app_settings where id = 1);
  v_any boolean;
  v_program boolean;
begin
  select * into p from public.profiles where id = p_user;
  if not found or p.role <> 'sales' then return 'not_sales'; end if;
  if not p.active then return 'inactive'; end if;
  if exists (select 1 from public.time_off t, private.cairo_clock(p_at) c
             where t.user_id = p_user and c.day between t.starts_on and t.ends_on) then
    return 'on_leave';
  end if;
  select bool_or(true), bool_or(p_program = any (s.program_ids)) into v_any, v_program
  from public.shifts s where s.user_id = p_user and private.shift_covers(s, p_at);
  if not coalesce(v_any, false) then return 'off_shift'; end if;
  -- Overlapping shifts of the same agent count once: any covering shift that includes the program.
  if not coalesce(v_program, false) then return 'program_not_on_shift'; end if;
  if p.paused then return 'paused'; end if;
  if v_cap_on and p.max_open_leads is not null and private.open_lead_count(p_user) >= p.max_open_leads then
    return 'at_capacity';
  end if;
  return null;
end $$;

-- ── Assignment ───────────────────────────────────────────────────────────

-- Assigns one waiting inquiry to the next eligible agent. Returns the agent, or null.
-- Locks the program's rotation row, so concurrent runs take turns and never skip or double up.
create or replace function private.assign_next(p_inquiry uuid, p_at timestamptz default now())
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  q public.inquiries;
  r public.rotation_state;
  v_agent public.profiles;
  v_name text;
begin
  select * into q from public.inquiries where id = p_inquiry for update;
  if not found or q.sales_owner_id is not null then return null; end if;
  if private.stage_key_of(p_inquiry) in ('enrolled', 'lost', 'invalid') then return null; end if;

  insert into public.rotation_state (program_id) values (q.program_id) on conflict do nothing;
  select * into r from public.rotation_state where program_id = q.program_id for update;

  -- First eligible agent after the last one, wrapping around.
  select p.* into v_agent
  from public.profiles p
  where p.role = 'sales' and p.active and private.ineligible_reason(p.id, q.program_id, p_at) is null
  order by (p.rotation_order <= coalesce(r.last_rotation_order, -2147483648)), p.rotation_order, p.created_at
  limit 1;
  if not found then return null; end if;

  update public.inquiries
     set sales_owner_id = v_agent.id, assigned_at = p_at, assignment_method = 'round_robin', version = version + 1
   where id = p_inquiry and sales_owner_id is null;
  update public.rotation_state
     set last_user_id = v_agent.id, last_rotation_order = v_agent.rotation_order, last_assigned_at = p_at
   where program_id = q.program_id;

  v_name := private.contact_name(p_inquiry);
  -- Open follow-ups (from an earlier owner) move with the lead.
  update public.follow_ups set owner_id = v_agent.id where inquiry_id = p_inquiry and status = 'open';
  -- Logged as the system even when a manager pressed "Run assignment".
  insert into public.activities (inquiry_id, type, actor_id, body, meta)
  values (p_inquiry, 'owner_change', null, 'Assigned automatically (round-robin)',
          jsonb_build_object('to', v_agent.id, 'method', 'round_robin'));
  perform private.notify(v_agent.id, 'New lead assigned: ' || v_name, p_inquiry);
  return v_agent.id;
end $$;

-- Assigns every waiting inquiry, oldest first. Also ends pauses of agents whose shift is over
-- and alerts managers (at most hourly per program) when leads are waiting with nobody eligible.
create or replace function private.assign_waiting(p_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  rec record;
  v_assigned integer := 0;
  v_waiting integer := 0;
  v_unpaused integer := 0;
  m record;
begin
  -- "Pause ends at shift end": an agent with no covering shift is no longer paused.
  with ended as (
    update public.profiles p set paused = false, paused_at = null
    where p.paused and p.role = 'sales'
      and not exists (select 1 from public.shifts s where s.user_id = p.id and private.shift_covers(s, p_at))
    returning p.full_name
  )
  select count(*) into v_unpaused from ended;

  for rec in
    select i.id, i.program_id from public.inquiries i join public.stages s on s.id = i.stage_id
    where i.sales_owner_id is null and not s.is_closed
    order by i.created_at, i.id
  loop
    if private.assign_next(rec.id, p_at) is not null then
      v_assigned := v_assigned + 1;
    else
      v_waiting := v_waiting + 1;
    end if;
  end loop;

  -- Tell managers about programs with leads waiting and nobody eligible.
  for m in
    select i.program_id, pr.code, count(*) as n
    from public.inquiries i join public.stages s on s.id = i.stage_id join public.programs pr on pr.id = i.program_id
    join public.rotation_state r on r.program_id = i.program_id
    where i.sales_owner_id is null and not s.is_closed
      and i.created_at < p_at - interval '10 minutes'
      and (r.last_no_agent_alert_at is null or r.last_no_agent_alert_at < p_at - interval '1 hour')
    group by i.program_id, pr.code
  loop
    insert into public.notifications (user_id, text)
    select id, format('%s %s lead%s waiting: no sales agent is on shift for %s.', m.n, m.code, case when m.n = 1 then '' else 's' end, m.code)
    from public.profiles where role = 'manager' and active;
    update public.rotation_state set last_no_agent_alert_at = p_at where program_id = m.program_id;
  end loop;

  return jsonb_build_object('assigned', v_assigned, 'waiting', v_waiting, 'pauses_ended', v_unpaused);
end $$;

revoke all on function private.assign_next(uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.assign_waiting(timestamptz) from public, anon, authenticated;

-- Manager "Run assignment now".
create or replace function public.run_assignment()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform private.require_role('manager');
  v := private.assign_waiting(now());
  perform private.audit('Ran assignment', format('%s assigned, %s still waiting', v ->> 'assigned', v ->> 'waiting'));
  return v;
end $$;

-- Team status for the Overview: every sales agent × program, with the reason when not eligible.
create or replace function public.eligibility_now()
returns table (user_id uuid, program_id uuid, reason text, open_leads integer, on_shift_until text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_role('manager');
  return query
  select p.id, pr.id, private.ineligible_reason(p.id, pr.id, now()), private.open_lead_count(p.id),
         (select to_char(make_time(s.end_minute / 60, s.end_minute % 60, 0), 'HH24:MI')
            from public.shifts s where s.user_id = p.id and private.shift_covers(s, now()) limit 1)
  from public.profiles p cross join public.programs pr
  where p.role = 'sales' and pr.active;
end $$;

-- ── Managing shifts, leave and rotation ──────────────────────────────────

-- p: id (optional), user_id, weekday, start ("HH:MM"), end ("HH:MM"), program_ids
create or replace function public.save_shift(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_user uuid := (p ->> 'user_id')::uuid;
  v_start integer;
  v_end integer;
  v_programs uuid[];
  v_name text;
begin
  perform private.require_role('manager');
  select full_name into v_name from public.profiles where id = v_user and role = 'sales';
  if v_name is null then perform private.fail('Shifts are for sales agents.'); end if;
  if coalesce(p ->> 'start', '') !~ '^([01]\d|2[0-3]):[0-5]\d$' or coalesce(p ->> 'end', '') !~ '^([01]\d|2[0-3]):[0-5]\d$' then
    perform private.fail('Enter start and end times as HH:MM.');
  end if;
  v_start := split_part(p ->> 'start', ':', 1)::integer * 60 + split_part(p ->> 'start', ':', 2)::integer;
  v_end := split_part(p ->> 'end', ':', 1)::integer * 60 + split_part(p ->> 'end', ':', 2)::integer;
  select coalesce(array_agg(x::uuid), '{}') into v_programs from jsonb_array_elements_text(coalesce(p -> 'program_ids', '[]')) x;
  if cardinality(v_programs) = 0 then perform private.fail('Choose at least one program for this shift.'); end if;
  if exists (select 1 from unnest(v_programs) x where not exists (select 1 from public.programs where id = x)) then
    perform private.fail('Unknown program.');
  end if;
  if (p ->> 'weekday')::integer not between 0 and 6 then perform private.fail('Choose a day.'); end if;

  if v_id is null then
    insert into public.shifts (user_id, weekday, start_minute, end_minute, program_ids)
    values (v_user, (p ->> 'weekday')::smallint, v_start, v_end, v_programs) returning id into v_id;
  else
    update public.shifts set user_id = v_user, weekday = (p ->> 'weekday')::smallint, start_minute = v_start,
           end_minute = v_end, program_ids = v_programs where id = v_id;
    if not found then raise exception using errcode = 'CRM04', message = 'Shift not found.'; end if;
  end if;
  perform private.audit('Saved shift', format('%s · %s %s–%s', v_name,
    (array['Sun','Mon','Tue','Wed','Thu','Fri','Sat'])[(p ->> 'weekday')::integer + 1], p ->> 'start', p ->> 'end'));
  return v_id;
end $$;

create or replace function public.delete_shift(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  perform private.require_role('manager');
  delete from public.shifts s using public.profiles p where s.id = p_id and p.id = s.user_id returning p.full_name into v_name;
  if v_name is null then raise exception using errcode = 'CRM04', message = 'Shift not found.'; end if;
  perform private.audit('Deleted shift', v_name);
end $$;

-- Copies one agent's shifts to other agents (replacing theirs). Saves typing for teams on the same schedule.
create or replace function public.copy_shifts(p_from uuid, p_to uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_role('manager');
  if exists (select 1 from unnest(p_to) t where not exists (select 1 from public.profiles where id = t and role = 'sales')) then
    perform private.fail('Shifts can only be copied to sales agents.');
  end if;
  delete from public.shifts where user_id = any (p_to) and user_id <> p_from;
  insert into public.shifts (user_id, weekday, start_minute, end_minute, program_ids)
  select t, s.weekday, s.start_minute, s.end_minute, s.program_ids
  from public.shifts s cross join unnest(p_to) t where s.user_id = p_from and t <> p_from;
  perform private.audit('Copied shifts', (select full_name from public.profiles where id = p_from));
end $$;

create or replace function public.save_time_off(p_user uuid, p_starts date, p_ends date, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text;
begin
  perform private.require_role('manager');
  select full_name into v_name from public.profiles where id = p_user;
  if v_name is null then raise exception using errcode = 'CRM04', message = 'User not found.'; end if;
  if p_starts is null or p_ends is null or p_ends < p_starts then perform private.fail('Choose a valid date range.'); end if;
  insert into public.time_off (user_id, starts_on, ends_on, reason, created_by)
  values (p_user, p_starts, p_ends, nullif(trim(p_reason), ''), auth.uid()) returning id into v_id;
  perform private.audit('Added leave', format('%s · %s to %s', v_name, p_starts, p_ends));
  return v_id;
end $$;

create or replace function public.delete_time_off(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  perform private.require_role('manager');
  delete from public.time_off t using public.profiles p where t.id = p_id and p.id = t.user_id returning p.full_name into v_name;
  if v_name is null then raise exception using errcode = 'CRM04', message = 'Leave entry not found.'; end if;
  perform private.audit('Removed leave', v_name);
end $$;

-- Sets the rotation order to the given list of sales agents (first = 1).
create or replace function public.set_rotation_order(p_users uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_role('manager');
  if exists (select 1 from public.profiles p where p.role = 'sales' and not (p.id = any (p_users))) then
    perform private.fail('Include every sales agent in the order.');
  end if;
  update public.profiles p set rotation_order = x.n
  from unnest(p_users) with ordinality as x(id, n) where p.id = x.id and p.role = 'sales';
  -- Keep the pointer meaningful: point at the new position of the last agent who received a lead.
  update public.rotation_state r set last_rotation_order = p.rotation_order
  from public.profiles p where p.id = r.last_user_id;
  perform private.audit('Changed rotation order', 'Sales team');
end $$;

-- Moves an agent's open inquiries back to the queue (for redistribution), e.g. when they leave.
create or replace function public.redistribute_open_leads(p_user uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_ids uuid[];
  v_result jsonb;
begin
  perform private.require_role('manager');
  if coalesce(trim(p_reason), '') = '' then perform private.fail('Add a reason.'); end if;
  select full_name into v_name from public.profiles where id = p_user and role = 'sales';
  if v_name is null then perform private.fail('Choose a sales agent.'); end if;
  select coalesce(array_agg(i.id), '{}') into v_ids
  from public.inquiries i join public.stages s on s.id = i.stage_id
  where i.sales_owner_id = p_user and not s.is_closed;
  update public.inquiries set sales_owner_id = null, assigned_at = null, assignment_method = null, version = version + 1
  where id = any (v_ids);
  insert into public.activities (inquiry_id, type, actor_id, body, meta)
  select x, 'owner_change', auth.uid(), 'Returned to the queue for redistribution: ' || trim(p_reason), jsonb_build_object('from', p_user)
  from unnest(v_ids) x;
  perform private.audit(format('Redistributed %s open lead(s)', cardinality(v_ids)), v_name);
  v_result := private.assign_waiting(now());
  return jsonb_build_object('released', cardinality(v_ids)) || v_result;
end $$;

-- ── Changes to Phase 2 functions ─────────────────────────────────────────

-- Pausing records when it started (shown to managers).
create or replace function public.set_user_paused(p_user uuid, p_paused boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare my public.app_role := private.require_role('manager', 'sales'); v_name text;
begin
  if my = 'sales' then
    if p_user <> auth.uid() then
      raise exception using errcode = 'CRM03', message = 'You can only pause yourself.';
    end if;
    if not (select agents_can_pause from public.app_settings where id = 1) then
      perform private.fail('Pausing is turned off. Ask a manager.');
    end if;
  end if;
  update public.profiles set paused = p_paused, paused_at = case when p_paused then now() end
  where id = p_user and role = 'sales' returning full_name into v_name;
  if v_name is null then perform private.fail('Only sales agents can be paused.'); end if;
  perform private.audit(case when p_paused then 'Paused new leads' else 'Resumed new leads' end, v_name);
  -- Resuming may let waiting leads flow straight away.
  if not p_paused then perform private.assign_waiting(now()); end if;
end $$;

-- Reassignment marks the method; still never touches the rotation pointer.
create or replace function public.reassign_inquiry(p_inquiry uuid, p_to uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  q public.inquiries;
  v_name text;
begin
  perform private.require_role('manager');
  select * into q from public.inquiries where id = p_inquiry for update;
  if not found then raise exception using errcode = 'CRM04', message = 'This record does not exist.'; end if;
  if coalesce(trim(p_reason), '') = '' then perform private.fail('Add a reason for the reassignment.'); end if;
  select full_name into v_name from public.profiles where id = p_to and role = 'sales' and active;
  if v_name is null then perform private.fail('Choose an active sales agent.'); end if;
  if q.sales_owner_id = p_to then return; end if;
  update public.inquiries set sales_owner_id = p_to, assigned_at = now(), assignment_method = 'manual', version = version + 1
  where id = p_inquiry;
  update public.follow_ups set owner_id = p_to where inquiry_id = p_inquiry and status = 'open';
  perform private.log_activity(p_inquiry, 'owner_change',
    case when q.sales_owner_id is null then 'Assigned by manager: ' else 'Reassigned: ' end || trim(p_reason),
    jsonb_build_object('from', q.sales_owner_id, 'to', p_to, 'method', 'manual'));
  perform private.notify(p_to, 'Lead assigned to you: ' || private.contact_name(p_inquiry), p_inquiry);
  perform private.audit('Assigned lead to ' || v_name || ' (' || trim(p_reason) || ')', private.contact_name(p_inquiry));
end $$;

-- Deactivating an agent can return their open leads to the queue.
create or replace function public.set_user_active(p_user uuid, p_active boolean, p_redistribute boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  perform private.require_role('manager');
  update public.profiles set active = p_active, paused = case when p_active then paused else false end
  where id = p_user returning full_name into v_name;
  if v_name is null then raise exception using errcode = 'CRM04', message = 'User not found.'; end if;
  perform private.audit(case when p_active then 'Reactivated user' else 'Deactivated user' end, v_name);
  if not p_active and p_redistribute then
    perform public.redistribute_open_leads(p_user, 'Agent deactivated');
  end if;
end $$;
drop function if exists public.set_user_active(uuid, boolean);

grant execute on function public.run_assignment(), public.eligibility_now(), public.save_shift(jsonb),
  public.delete_shift(uuid), public.copy_shifts(uuid, uuid[]), public.save_time_off(uuid, date, date, text),
  public.delete_time_off(uuid), public.set_rotation_order(uuid[]), public.redistribute_open_leads(uuid, text),
  public.set_user_active(uuid, boolean, boolean) to authenticated;
revoke execute on function public.run_assignment(), public.eligibility_now(), public.save_shift(jsonb),
  public.delete_shift(uuid), public.copy_shifts(uuid, uuid[]), public.save_time_off(uuid, date, date, text),
  public.delete_time_off(uuid), public.set_rotation_order(uuid[]), public.redistribute_open_leads(uuid, text),
  public.set_user_active(uuid, boolean, boolean) from public, anon;

-- Manager-created inquiries without a chosen agent go through round-robin immediately.
create or replace function public.create_inquiry(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  my public.app_role := private.require_role('manager', 'sales');
  v_contact uuid;
  v_existing boolean := false;
  v_program public.programs;
  v_owner uuid;
  v_student text := nullif(trim(p ->> 'student_name'), '');
  v_dup public.inquiries;
  v_id uuid;
  v_missing text[];
begin
  if coalesce(trim(p ->> 'name'), '') = '' then perform private.fail('Name is required.'); end if;
  if coalesce(p ->> 'phone_normalized', '') !~ '^\+?[0-9]{8,15}$' then perform private.fail('Enter a valid phone number.'); end if;
  select * into v_program from public.programs where id = (p ->> 'program_id')::uuid and active;
  if not found then perform private.fail('Choose a program.'); end if;

  -- One contact per phone. Concurrent inserts of the same phone resolve to one row.
  insert into public.contacts (name, phone, phone_normalized, phone_secondary, phone_secondary_normalized, contact_type, created_by)
  values (trim(p ->> 'name'), trim(p ->> 'phone'), p ->> 'phone_normalized',
          nullif(trim(p ->> 'phone_secondary'), ''), nullif(p ->> 'phone_secondary_normalized', ''),
          coalesce((p ->> 'contact_type')::public.contact_type, 'student'), me)
  on conflict (phone_normalized) do nothing
  returning id into v_contact;
  if v_contact is null then
    select id into v_contact from public.contacts where phone_normalized = p ->> 'phone_normalized';
    v_existing := true;
  end if;

  -- Same person, same program, same student, still open: no duplicate inquiry.
  select i.* into v_dup
  from public.inquiries i join public.stages s on s.id = i.stage_id
  where i.contact_id = v_contact and i.program_id = v_program.id and not s.is_closed
    and coalesce(lower(i.student_name), '') = coalesce(lower(v_student), '')
  limit 1;
  if found then
    if my = 'manager' or v_dup.sales_owner_id = me then
      perform private.fail(format('This person already has an open %s inquiry%s. Add a student name if it is for a different child.',
        v_program.code, coalesce(' with ' || (select full_name from public.profiles where id = v_dup.sales_owner_id), ' in the unassigned queue')));
    else
      perform private.fail(format('This person already has an open %s inquiry with another agent. Ask a manager if it should move to you.', v_program.code));
    end if;
  end if;

  if my = 'sales' then
    v_owner := me; -- An agent who adds a customer keeps it.
  else
    v_owner := nullif(p ->> 'assign_to', '')::uuid;
    if v_owner is not null and not exists (select 1 from public.profiles where id = v_owner and role = 'sales' and active) then
      perform private.fail('Choose an active sales agent, or leave the inquiry in the queue.');
    end if;
  end if;

  insert into public.inquiries (contact_id, program_id, student_name, stage_id, sales_owner_id, source, created_by, assigned_at, assignment_method)
  values (v_contact, v_program.id, v_student, (select id from public.stages where system_key = 'new'),
          v_owner, 'manual', me, case when v_owner is not null then now() end,
          case when v_owner is null then null when v_owner = me then 'creator' else 'manual' end)
  returning id into v_id;

  perform private.write_field_values(v_id, p -> 'custom', my);
  v_missing := private.missing_required(v_id, 'new');
  if cardinality(v_missing) > 0 then
    perform private.fail('Fill in the required fields.', to_jsonb(v_missing)::text);
  end if;

  perform private.log_activity(v_id, 'comment',
    case when v_existing then 'Created manually · linked to existing contact' else 'Created manually' end);
  if v_owner is not null then
    perform private.log_activity(v_id, 'owner_change',
      case when v_owner = me then 'Owned by creator' else 'Assigned by manager' end, jsonb_build_object('to', v_owner));
    if v_owner <> me then
      perform private.notify(v_owner, 'New lead assigned: ' || trim(p ->> 'name'), v_id);
    end if;
  else
    -- No owner chosen: round-robin right away; if nobody is eligible it waits in the queue.
    v_owner := private.assign_next(v_id, now());
    if v_owner is null then
      perform private.log_activity(v_id, 'owner_change', 'Waiting in the unassigned queue');
    end if;
  end if;

  return jsonb_build_object('inquiry_id', v_id, 'queued', v_owner is null, 'matched_existing', v_existing,
                            'owner_id', v_owner);
end $$;
