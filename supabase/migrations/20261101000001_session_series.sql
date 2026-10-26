-- ===== CRM changes · Part E · 26 Oct 2026 =====
-- Weekly series of sessions are linked (teacher_sessions.series_id), so moving or removing a session
-- can apply to only this one, this and the following ones, or all of the series.
--   * Only sessions still scheduled change; recorded sessions and sessions in a closed salary month
--     are never touched.
--   * Series made before this change are linked when their sessions were scheduled together
--     (same teacher assignment, same scheduling moment, weekday, time and length).
-- Additive: one column, two functions; schedule_sessions links new series; sessions_view returns series_id.

alter table public.teacher_sessions add column if not exists series_id uuid;
create index if not exists teacher_sessions_series_idx on public.teacher_sessions (series_id) where series_id is not null;

-- Link the series scheduled before this change.
with groups as (
  select assignment_id, created_at, extract(isodow from starts_at at time zone 'Africa/Cairo') as dow,
         (starts_at at time zone 'Africa/Cairo')::time as tm, planned_hours, gen_random_uuid() as sid
    from public.teacher_sessions
   where series_id is null
   group by 1, 2, 3, 4, 5
  having count(*) > 1
)
update public.teacher_sessions s set series_id = g.sid
  from groups g
 where s.series_id is null and s.assignment_id = g.assignment_id and s.created_at = g.created_at
   and extract(isodow from s.starts_at at time zone 'Africa/Cairo') = g.dow
   and (s.starts_at at time zone 'Africa/Cairo')::time = g.tm and s.planned_hours = g.planned_hours;

create or replace function public.schedule_sessions(p jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  a public.teacher_assignments;
  v_start timestamptz := nullif(p ->> 'starts_at', '')::timestamptz;
  v_hours numeric := nullif(p ->> 'planned_hours', '')::numeric;
  v_repeat integer := coalesce(nullif(p ->> 'repeat_weeks', '')::integer, 0);
  v_inquiry uuid;
  v_series uuid;
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
  if v_repeat > 0 then v_series := gen_random_uuid(); end if;  -- a weekly series is linked, so it can be changed together
  for i in 0 .. v_repeat loop
    insert into public.teacher_sessions (assignment_id, teacher_id, rate_id, enrollment_id, course_id, starts_at, planned_hours, note, created_by, series_id)
    values (a.id, a.teacher_id, a.rate_id, a.enrollment_id, a.course_id, v_start + make_interval(days => 7 * i), v_hours, nullif(trim(p ->> 'note'), ''), auth.uid(), v_series);
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

drop function if exists public.sessions_view(date, date);
create or replace function public.sessions_view(p_from date, p_to date)
returns table (id uuid, assignment_id uuid, teacher_id uuid, rate_id uuid, enrollment_id uuid, course_id uuid, inquiry_id uuid,
               customer_name text, support_owner_id uuid, starts_at timestamptz, planned_hours numeric, status text, hours numeric,
               late_cancel boolean, paid_hours numeric, student_hours numeric, note text, recorded_by uuid, recorded_at timestamptz, subject text, series_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare v_role public.app_role := private.require_role('manager', 'support', 'accountant');
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then perform private.fail('Choose a valid date range (at most 400 days).'); end if;
  return query
    select s.id, s.assignment_id, s.teacher_id, s.rate_id, s.enrollment_id, s.course_id, e.inquiry_id, c.name, o.support_owner_id,
           s.starts_at, s.planned_hours, s.status, s.hours, s.late_cancel, s.paid_hours, s.student_hours, s.note, s.recorded_by, s.recorded_at, a.subject, s.series_id
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

-- How far a change to this session could go: counts for "this and the following" and "all".
create or replace function public.session_series_info(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s public.teacher_sessions;
  a public.teacher_assignments;
begin
  perform private.require_role('manager', 'support');
  select * into s from public.teacher_sessions where id = p_id;
  if not found then raise exception using errcode = 'CRM04', message = 'Session not found.'; end if;
  select * into a from public.teacher_assignments where id = s.assignment_id;
  if not private.can_run_sessions(a) then raise exception using errcode = 'CRM04', message = 'This customer is not assigned to you.'; end if;
  if s.series_id is null then return jsonb_build_object('seriesId', null); end if;
  return (select jsonb_build_object(
      'seriesId', s.series_id,
      'total', count(*),
      'following', count(*) filter (where x.status = 'scheduled' and x.starts_at >= s.starts_at
                                    and not private.salary_closed(private.salary_month_of((x.starts_at at time zone 'Africa/Cairo')::date))),
      'all', count(*) filter (where x.status = 'scheduled'
                              and not private.salary_closed(private.salary_month_of((x.starts_at at time zone 'Africa/Cairo')::date))),
      'recorded', count(*) filter (where x.status <> 'scheduled'))
    from public.teacher_sessions x where x.series_id = s.series_id);
end $$;

-- Move or remove sessions of a series. p: id, scope 'following' | 'all', action 'move' | 'remove',
-- starts_at (move: the new date and time of THIS session; the others move by the same amount), planned_hours?
create or replace function public.change_session_series(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.teacher_sessions;
  a public.teacher_assignments;
  v_scope text := p ->> 'scope';
  v_action text := p ->> 'action';
  v_new timestamptz := nullif(p ->> 'starts_at', '')::timestamptz;
  v_hours numeric := nullif(p ->> 'planned_hours', '')::numeric;
  v_delta interval;
  v_ids uuid[];
  v_n integer;
  v_inquiry uuid;
  v_teacher text;
begin
  perform private.require_role('manager', 'support');
  select * into s from public.teacher_sessions where id = (p ->> 'id')::uuid;
  if not found then raise exception using errcode = 'CRM04', message = 'Session not found.'; end if;
  select * into a from public.teacher_assignments where id = s.assignment_id;
  if not private.can_run_sessions(a) then raise exception using errcode = 'CRM04', message = 'This customer is not assigned to you.'; end if;
  if s.series_id is null then perform private.fail('This session is not part of a weekly series.'); end if;
  if v_scope not in ('following', 'all') then perform private.fail('Choose which sessions to change.'); end if;
  if v_action not in ('move', 'remove') then perform private.fail('Choose move or remove.'); end if;

  -- The sessions that change: still scheduled, not in a closed salary month.
  select coalesce(array_agg(x.id order by x.starts_at), '{}') into v_ids
    from public.teacher_sessions x
   where x.series_id = s.series_id and x.status = 'scheduled'
     and (v_scope = 'all' or x.starts_at >= s.starts_at)
     and not private.salary_closed(private.salary_month_of((x.starts_at at time zone 'Africa/Cairo')::date));
  v_n := cardinality(v_ids);
  if v_n = 0 then perform private.fail('There are no sessions left to change in this series (recorded sessions and closed months are not changed).'); end if;
  perform 1 from public.teacher_sessions where id = any (v_ids) order by id for update;
  v_teacher := (select full_name from public.teachers where id = a.teacher_id);
  if a.enrollment_id is not null then select inquiry_id into v_inquiry from public.enrollments where id = a.enrollment_id; end if;

  if v_action = 'remove' then
    delete from public.teacher_sessions where id = any (v_ids);
    if v_inquiry is not null then
      perform private.log_activity(v_inquiry, 'session', format('%s session%s with %s removed (%s)', v_n, case when v_n = 1 then '' else 's' end, v_teacher,
        case v_scope when 'all' then 'the whole series' else 'from ' || to_char(s.starts_at at time zone 'Africa/Cairo', 'Dy FMDD Mon') || ' on' end),
        jsonb_build_object('series_id', s.series_id, 'count', v_n));
    end if;
    return jsonb_build_object('changed', v_n, 'action', 'remove');
  end if;

  -- Move: every session shifts by the same amount as this one.
  if v_new is null then perform private.fail('Choose the new date and time.'); end if;
  if v_hours is not null and (v_hours < 0.25 or v_hours > 12) then perform private.fail('Enter the session length in hours (0.25 to 12).'); end if;
  v_delta := v_new - s.starts_at;
  if exists (select 1 from public.teacher_sessions x where x.id = any (v_ids)
             and ((((x.starts_at + v_delta) at time zone 'Africa/Cairo')::date < a.started_on)
                  or (a.ended_on is not null and ((x.starts_at + v_delta) at time zone 'Africa/Cairo')::date > a.ended_on))) then
    perform private.fail('Some sessions would fall outside the dates this teacher teaches this customer.');
  end if;
  if exists (select 1 from public.teacher_sessions x join public.teacher_sessions y on y.assignment_id = x.assignment_id
             where x.id = any (v_ids) and not (y.id = any (v_ids)) and y.starts_at = x.starts_at + v_delta) then
    perform private.fail('There is already a session with this teacher at one of the new times.');
  end if;
  update public.teacher_sessions
     set starts_at = starts_at + v_delta, planned_hours = coalesce(v_hours, planned_hours), updated_at = now()
   where id = any (v_ids);
  if v_inquiry is not null then
    perform private.log_activity(v_inquiry, 'session', format('%s session%s with %s moved to %s', v_n, case when v_n = 1 then '' else 's' end, v_teacher,
      to_char(v_new at time zone 'Africa/Cairo', 'FMDay"s", FMHH12:MI AM') || coalesce(' (' || private.hours_text(v_hours) || ' h each)', '')),
      jsonb_build_object('series_id', s.series_id, 'count', v_n));
  end if;
  return jsonb_build_object('changed', v_n, 'action', 'move');
end $$;

revoke all on function public.sessions_view(date, date), public.session_series_info(uuid), public.change_session_series(jsonb) from public, anon;
grant execute on function public.sessions_view(date, date), public.session_series_info(uuid), public.change_session_series(jsonb) to authenticated;
