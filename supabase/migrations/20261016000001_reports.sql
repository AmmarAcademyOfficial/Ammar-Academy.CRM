-- Phase 5 · Reports
--
-- One manager-only function returns every report figure for a date range, using the
-- metric definitions approved in Phase 1. All date ranges are Cairo calendar days,
-- start and end inclusive.
--
--   Inquiry figures (new inquiries, stages, sources, assignments, first contact, lost)
--     filter on the inquiry's program and the course type of the inquiry's course.
--   Enrollment and payment figures filter on the enrollment's program and course.
--   "Right now" figures (overdue follow-ups, awaiting onboarding, flagged) ignore the range.
--
-- Time to first contact counts only the agent's scheduled shift minutes (Cairo time),
-- skipping their leave days. An agent with no shifts at all is measured in clock time.

-- Minutes of p_user's scheduled shifts between two instants (overlapping shifts counted once).
create or replace function private.working_minutes(p_user uuid, p_from timestamptz, p_to timestamptz)
returns numeric language sql stable set search_path = '' as $$
  with days as (
    select d::date as d
    from generate_series((p_from at time zone 'Africa/Cairo')::date - 1, (p_to at time zone 'Africa/Cairo')::date, interval '1 day') d
  ),
  win as (
    select tstzrange(
             (days.d + make_interval(mins => s.start_minute)) at time zone 'Africa/Cairo',
             (days.d + make_interval(mins => s.end_minute)
                     + case when s.end_minute <= s.start_minute then interval '1 day' else interval '0' end) at time zone 'Africa/Cairo') as r
    from days
    join public.shifts s on s.user_id = p_user and s.weekday = extract(dow from days.d)
    where not exists (select 1 from public.time_off t where t.user_id = p_user and days.d between t.starts_on and t.ends_on)
  )
  select case
    when p_to <= p_from then 0
    when not exists (select 1 from public.shifts where user_id = p_user) then round(extract(epoch from p_to - p_from) / 60, 1)
    else coalesce((
      select round(sum(extract(epoch from upper(x) - lower(x))) / 60, 1)
      from unnest((select range_agg(r) from win) * tstzmultirange(tstzrange(p_from, p_to))) x), 0)
  end
$$;

create or replace function public.report(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_from_day date := (p ->> 'from')::date;
  v_to_day date := (p ->> 'to')::date;
  v_from timestamptz;
  v_to timestamptz;
  v_program uuid := nullif(p ->> 'program_id', '')::uuid;
  v_type uuid := nullif(p ->> 'course_type_id', '')::uuid;
  v_target integer;
  out jsonb;
begin
  perform private.require_role('manager');
  if v_from_day is null or v_to_day is null then perform private.fail('Choose a date range.'); end if;
  if v_to_day < v_from_day then perform private.fail('The end date is before the start date.'); end if;
  if v_to_day - v_from_day > 731 then perform private.fail('Choose a range of two years or less.'); end if;
  v_from := v_from_day::timestamp at time zone 'Africa/Cairo';
  v_to := (v_to_day + 1)::timestamp at time zone 'Africa/Cairo';
  select first_contact_target_minutes into v_target from public.app_settings where id = 1;

  with
  inq as (  -- inquiries in scope (program and course type), any date
    select i.*, s.system_key as stage_key, s.label as stage_label, s.sort as stage_sort, c.name as course_name, c.course_type_id
    from public.inquiries i
    join public.stages s on s.id = i.stage_id
    left join public.courses c on c.id = i.course_id
    where (v_program is null or i.program_id = v_program)
      and (v_type is null or c.course_type_id = v_type)
  ),
  created as (select * from inq where created_at >= v_from and created_at < v_to),
  assigned as (select * from inq where sales_owner_id is not null and assigned_at >= v_from and assigned_at < v_to),
  fc as (  -- first contact, measured from the current assignment
    select a.id, a.sales_owner_id, a.first_contact_attempt_at,
           case when a.first_contact_attempt_at >= a.assigned_at
                then private.working_minutes(a.sales_owner_id, a.assigned_at, a.first_contact_attempt_at) end as work_min,
           case when a.first_contact_attempt_at >= a.assigned_at
                then round(extract(epoch from a.first_contact_attempt_at - a.assigned_at) / 60, 1) end as clock_min
    from assigned a
  ),
  enr as (  -- enrollments in scope with their course
    select e.*, i.program_id, c.name as course_name, c.course_type_id
    from public.enrollments e
    join public.inquiries i on i.id = e.inquiry_id
    join public.courses c on c.id = e.course_id
    where (v_program is null or i.program_id = v_program)
      and (v_type is null or c.course_type_id = v_type)
  ),
  handed as (  -- enrollments handed over to support in range (one per enrollment)
    select enr.*, o.created_at as handed_at, o.claimed_at, o.activated_at, o.support_owner_id
    from enr join public.onboardings o on o.enrollment_id = enr.id
    where o.created_at >= v_from and o.created_at < v_to
  ),
  conf as (  -- confirmed in range; pending, rejected and reversed excluded
    select pay.amount, enr.currency, enr.course_id, enr.course_name, enr.course_type_id, enr.original_sales_owner_id, pay.decided_at
    from public.payments pay join enr on enr.id = pay.enrollment_id
    where pay.status = 'confirmed' and pay.decided_at >= v_from and pay.decided_at < v_to
  ),
  lost as (
    select q.*, (select max(a.created_at) from public.activities a
                 where a.inquiry_id = q.id and a.type = 'stage_change' and a.meta ->> 'to' = 'lost') as lost_at
    from inq q where q.stage_key = 'lost'
  ),
  agents as (select id, full_name, active from public.profiles where role = 'sales'),
  days as (select d::date as d from generate_series(v_from_day, v_to_day, interval '1 day') d)
  select jsonb_build_object(
    'range', jsonb_build_object('from', v_from_day, 'to', v_to_day),
    'firstContactTargetMinutes', v_target,
    'newInquiries', (select count(*) from created),
    'distinctContacts', (select count(distinct contact_id) from created),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', days.d, 'inquiries', coalesce(ci.n, 0), 'enrollments', coalesce(ch.n, 0)) order by days.d), '[]'::jsonb)
              from days
              left join (select (created_at at time zone 'Africa/Cairo')::date as d, count(*) as n from created group by 1) ci on ci.d = days.d
              left join (select (handed_at at time zone 'Africa/Cairo')::date as d, count(*) as n from handed group by 1) ch on ch.d = days.d),
    'firstContact', (select jsonb_build_object(
                'medianWorkingMinutes', percentile_disc(0.5) within group (order by work_min) filter (where work_min is not null),
                'medianClockMinutes', percentile_disc(0.5) within group (order by clock_min) filter (where clock_min is not null),
                'measured', count(*) filter (where work_min is not null),
                'withinTarget', count(*) filter (where work_min <= v_target),
                'notYet', count(*) filter (where first_contact_attempt_at is null)) from fc),
    'enrollments', (select count(*) from handed),
    'confirmed', (select coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'amount', amount, 'count', n) order by currency), '[]'::jsonb)
                  from (select currency, sum(amount) as amount, count(*) as n from conf group by currency) x),
    'overdueFollowUps', (select count(*) from public.follow_ups f join inq on inq.id = f.inquiry_id where f.status = 'open' and f.due_at < now()),
    'overdueByOwner', (select coalesce(jsonb_agg(jsonb_build_object('label', coalesce(pr.full_name, 'Unassigned'), 'count', n) order by n desc), '[]'::jsonb)
                       from (select f.owner_id, count(*) as n from public.follow_ups f join inq on inq.id = f.inquiry_id
                             where f.status = 'open' and f.due_at < now() group by f.owner_id) x
                       left join public.profiles pr on pr.id = x.owner_id),
    'awaitingOnboarding', (select count(*) from public.onboardings o join enr on enr.id = o.enrollment_id where o.support_owner_id is null),
    'flaggedNow', (select count(*) from public.onboardings o join enr on enr.id = o.enrollment_id where o.flagged_reason is not null),
    'assignedTotal', (select count(*) from assigned),
    'byStage', (select coalesce(jsonb_agg(jsonb_build_object('key', stage_key, 'label', stage_label, 'count', n) order by stage_sort), '[]'::jsonb)
                from (select stage_key, stage_label, stage_sort, count(*) as n from created group by 1, 2, 3) x),
    'bySource', (select coalesce(jsonb_agg(jsonb_build_object('label', label, 'count', n) order by n desc, label), '[]'::jsonb)
                 from (select coalesce(case when c.source = 'manual' then 'Manual entry' end,
                                       sc.spreadsheet_name || ' · ' || sc.sheet_title, 'Google Sheet (removed)') as label, count(*) as n
                       from created c left join public.sheet_connections sc on sc.id = c.source_connection_id group by 1) x),
    'lostReasons', (select coalesce(jsonb_agg(jsonb_build_object('label', label, 'count', n) order by n desc, label), '[]'::jsonb)
                    from (select coalesce(nullif(trim(lost_reason), ''), 'No reason') as label, count(*) as n
                          from lost where lost_at >= v_from and lost_at < v_to group by 1) x),
    'lostTotal', (select count(*) from lost where lost_at >= v_from and lost_at < v_to),
    'agents', (select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x."assigned" desc, x."name"), '[]'::jsonb) from (
                 select ag.id as "userId", ag.full_name as "name", ag.active as "active",
                   (select count(*) from assigned a where a.sales_owner_id = ag.id) as "assigned",
                   (select count(*) from assigned a where a.sales_owner_id = ag.id and a.first_contact_attempt_at is not null) as "contacted",
                   (select percentile_disc(0.5) within group (order by work_min) from fc where fc.sales_owner_id = ag.id and work_min is not null) as "medianWorkingMinutes",
                   (select count(*) from assigned a where a.sales_owner_id = ag.id and a.stage_key = 'enrolled') as "assignedNowEnrolled",
                   (select count(*) from handed h where h.original_sales_owner_id = ag.id) as "enrollments",
                   (select coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'amount', amount) order by currency), '[]'::jsonb)
                      from (select currency, sum(amount) as amount from conf where conf.original_sales_owner_id = ag.id group by currency) y) as "confirmed",
                   (select count(*) from public.inquiries oi join public.stages os on os.id = oi.stage_id
                     where oi.sales_owner_id = ag.id and not os.is_closed
                       and (v_program is null or oi.program_id = v_program)) as "openNow"
                 from agents ag
               ) x where x."assigned" > 0 or x."enrollments" > 0 or x."openNow" > 0 or x."active"),
    'courses', (select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x."enrollments" desc, x."inquiries" desc, x."name"), '[]'::jsonb) from (
                 select co.id as "courseId", co.name as "name", co.course_type_id as "courseTypeId", co.program_id as "programId", co.price as "price",
                   (select count(*) from created c where c.course_id = co.id) as "inquiries",
                   (select count(*) from handed h where h.course_id = co.id) as "enrollments",
                   (select coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'amount', amount) order by currency), '[]'::jsonb)
                      from (select currency, sum(amount) as amount from conf where conf.course_id = co.id group by currency) y) as "confirmed"
                 from public.courses co
                 where (v_program is null or co.program_id = v_program) and (v_type is null or co.course_type_id = v_type)
               ) x where x."inquiries" > 0 or x."enrollments" > 0 or x."confirmed" <> '[]'::jsonb),
    'inquiriesWithoutCourse', (select count(*) from created where course_id is null),
    'courseTypes', (select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x."enrollments" desc, x."inquiries" desc, x."name"), '[]'::jsonb) from (
                 select t.id as "courseTypeId", t.name as "name", t.color as "color",
                   (select count(*) from created c where c.course_type_id = t.id) as "inquiries",
                   (select count(*) from handed h where h.course_type_id = t.id) as "enrollments",
                   (select coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'amount', amount) order by currency), '[]'::jsonb)
                      from (select currency, sum(amount) as amount from conf where conf.course_type_id = t.id group by currency) y) as "confirmed"
                 from public.course_types t where v_type is null or t.id = v_type
               ) x where x."inquiries" > 0 or x."enrollments" > 0),
    'support', (select jsonb_build_object(
                 'handedOver', count(*),
                 'claimed', count(*) filter (where claimed_at is not null),
                 'medianClaimMinutes', percentile_disc(0.5) within group (order by round(extract(epoch from claimed_at - handed_at) / 60, 1)) filter (where claimed_at is not null),
                 'activated', count(*) filter (where activated_at is not null)) from handed)
  ) into out;
  return out;
end $$;

revoke execute on function public.report(jsonb) from public, anon;
grant execute on function public.report(jsonb) to authenticated;
revoke execute on function private.working_minutes(uuid, timestamptz, timestamptz) from public, anon;
