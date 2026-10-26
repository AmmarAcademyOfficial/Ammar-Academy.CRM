-- ===== CRM changes · Part D · 26 Oct 2026 =====
-- Support and managers add an existing customer directly: contact (or an existing record), an
-- enrolled inquiry, the enrollment, payments already received, the plan for what is left, the
-- support onboarding and, optionally, the teacher and package hours already used — in one
-- all-or-nothing step.
--   * Marked inquiries.added_as_existing: no round-robin, no new-lead or not-opened alerts, and
--     Reports do not count them as new inquiries, enrollments or sales.
--   * Past payments: confirmed at once when a manager enters them; sent to review (like any support
--     payment) when support does. They show in Accounting on the date they were paid.
-- Additive: two columns, new functions; notify_new_lead, package_used and report gain one condition each.

alter table public.inquiries add column if not exists added_as_existing boolean not null default false;
alter table public.enrollments add column if not exists package_hours_before numeric(6, 2) not null default 0
  check (package_hours_before >= 0 and package_hours_before <= 1000);

-- Package hours used = hours used before the CRM + hours of sessions recorded in it.
create or replace function private.package_used(p_enrollment uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select package_hours_before from public.enrollments where id = p_enrollment), 0)
       + coalesce((select sum(student_hours) from public.teacher_sessions where enrollment_id = p_enrollment), 0)
$$;

-- No "New lead" alert for customers entered as existing.
create or replace function private.notify_new_lead()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_program text;
begin
  if new.created_at < now() - interval '1 day' or new.added_as_existing then return null; end if;
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

-- Who already has this phone (managers and support, before adding an existing customer).
create or replace function public.lookup_contact_by_phone(p_main text, p_secondary text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_contact uuid;
begin
  perform private.require_role('manager', 'support');
  if coalesce(p_main, '') !~ '^\+?[0-9]{8,15}$' then return null; end if;
  v_contact := private.find_contact_by_phone(p_main, nullif(p_secondary, ''));
  if v_contact is null then return null; end if;
  return (select jsonb_build_object('contactId', c.id, 'name', c.name,
            'inquiries', coalesce((select jsonb_agg(jsonb_build_object('inquiryId', i.id, 'program', coalesce(p.code, p.name),
                                     'student', i.student_name, 'stage', s.label,
                                     'course', (select co.name from public.enrollments e join public.courses co on co.id = e.course_id where e.inquiry_id = i.id))
                                   order by i.created_at desc)
                                   from public.inquiries i join public.programs p on p.id = i.program_id join public.stages s on s.id = i.stage_id
                                  where i.contact_id = c.id), '[]'))
            from public.contacts c where c.id = v_contact);
end $$;

-- p: contact_id? (add to that existing record) | name, phone, phone_normalized, phone_secondary?, phone_secondary_normalized?, contact_type
--    program_id, student_name?, course_id, agreed_total, price_note?, enrolled_on, sales_agent_id?,
--    support_owner_id?, status ('onboarding' | 'active'),
--    payments: [{amount, paid_on, method, kind, reference?, note?, receipt?: {path, name, mime, size}}],
--    dues: [{due_on, amount, note?}], teacher?: {teacher_id, rate_id, subject?}, package_hours_before?
create or replace function public.add_existing_customer(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  my public.app_role := private.require_role('manager', 'support');
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_contact uuid := nullif(p ->> 'contact_id', '')::uuid;
  v_program public.programs;
  v_course public.courses;
  v_student text := nullif(trim(p ->> 'student_name'), '');
  v_agreed numeric := nullif(p ->> 'agreed_total', '')::numeric;
  v_note text := nullif(trim(p ->> 'price_note'), '');
  v_enrolled date := coalesce(nullif(p ->> 'enrolled_on', '')::date, v_today);
  v_sales uuid := nullif(p ->> 'sales_agent_id', '')::uuid;
  v_support uuid := nullif(p ->> 'support_owner_id', '')::uuid;
  v_status text := coalesce(nullif(p ->> 'status', ''), 'onboarding');
  v_before numeric := coalesce(nullif(p ->> 'package_hours_before', '')::numeric, 0);
  v_inquiry uuid;
  v_enrollment uuid;
  v_onboarding uuid;
  v_name text;
  x jsonb;
  v_paid numeric := 0;
  v_pending numeric := 0;
  v_dues numeric := 0;
  v_count integer := 0;
  v_method public.payment_method;
  v_ref text;
  v_payment uuid;
  v_confirm boolean := my = 'manager';
  -- Past payments are stamped just before the plan, so they never count towards it.
  v_past_at timestamptz := now() - interval '1 second';
begin
  -- ── The person ──
  if v_contact is not null then
    select name into v_name from public.contacts where id = v_contact;
    if v_name is null then raise exception using errcode = 'CRM04', message = 'That customer record no longer exists.'; end if;
  else
    if coalesce(trim(p ->> 'name'), '') = '' then perform private.fail('Enter the customer''s name.'); end if;
    if coalesce(p ->> 'phone_normalized', '') !~ '^\+?[0-9]{8,15}$' then perform private.fail('Enter a valid phone number.'); end if;
    if private.find_contact_by_phone(p ->> 'phone_normalized', nullif(p ->> 'phone_secondary_normalized', '')) is not null then
      perform private.fail('This phone number is already in the CRM. Add the enrollment to that customer instead.');
    end if;
    insert into public.contacts (name, phone, phone_normalized, phone_secondary, phone_secondary_normalized, contact_type, created_by)
    values (trim(p ->> 'name'), trim(coalesce(p ->> 'phone', p ->> 'phone_normalized')), p ->> 'phone_normalized',
            nullif(trim(p ->> 'phone_secondary'), ''), nullif(p ->> 'phone_secondary_normalized', ''),
            coalesce(nullif(p ->> 'contact_type', '')::public.contact_type, 'student'), me)
    returning id, name into v_contact, v_name;
  end if;

  -- ── Program, course, price ──
  select * into v_program from public.programs where id = nullif(p ->> 'program_id', '')::uuid;
  if not found then perform private.fail('Choose a program.'); end if;
  select * into v_course from public.courses where id = nullif(p ->> 'course_id', '')::uuid;
  if not found or v_course.program_id <> v_program.id then perform private.fail('Choose a course of this program.'); end if;
  if v_agreed is null or v_agreed <= 0 then perform private.fail('Enter the agreed total.'); end if;
  if v_course.price is not null and abs(v_agreed - v_course.price) > 0.005 and v_note is null then
    perform private.fail(format('The agreed total differs from the course price (%s). Add a short reason, for example a sibling discount.', private.money(v_course.price, v_course.currency)));
  end if;
  if v_enrolled > v_today then perform private.fail('The enrolled date cannot be in the future.'); end if;
  if v_enrolled < v_today - 1825 then perform private.fail('The enrolled date is more than five years ago.'); end if;
  if exists (select 1 from public.inquiries i join public.enrollments e on e.inquiry_id = i.id
             where i.contact_id = v_contact and e.course_id = v_course.id and coalesce(lower(i.student_name), '') = coalesce(lower(v_student), '')) then
    perform private.fail('This customer is already enrolled in this course. Add a student name if it is for a different child.');
  end if;

  -- ── People ──
  if v_sales is not null and not exists (select 1 from public.profiles where id = v_sales and role in ('sales', 'manager')) then
    perform private.fail('Choose a sales agent from the list, or Before the CRM.');
  end if;
  if my = 'support' and v_support is null then v_support := me; end if;
  if v_support is not null and not exists (select 1 from public.profiles where id = v_support and role = 'support' and active) then
    perform private.fail('Choose an active support agent.');
  end if;
  if v_status not in ('onboarding', 'active') then perform private.fail('Choose the support status.'); end if;
  if v_before < 0 or v_before > 1000 then perform private.fail('Enter the package hours already used (0 to 1000).'); end if;

  -- ── Inquiry (already enrolled) and enrollment ──
  insert into public.inquiries (contact_id, program_id, student_name, stage_id, sales_owner_id, source, created_by, assigned_at,
                                assignment_method, course_id, added_as_existing)
  values (v_contact, v_program.id, v_student, (select id from public.stages where system_key = 'enrolled'), v_sales, 'manual', me,
          case when v_sales is not null then now() end, case when v_sales is not null then 'manual' end, v_course.id, true)
  returning id into v_inquiry;
  -- Never "not opened": this customer is not a new lead for anyone.
  update public.inquiries set owner_opened_at = now(), unopened_alert_at = now() where id = v_inquiry;

  insert into public.enrollments (inquiry_id, course_id, agreed_total, currency, price_note, original_sales_owner_id, created_by, created_at, package_hours_before)
  values (v_inquiry, v_course.id, v_agreed, v_course.currency, v_note, v_sales, me,
          (v_enrolled::timestamp + time '12:00') at time zone 'Africa/Cairo', v_before)
  returning id into v_enrollment;

  -- ── Payments already received ──
  for x in select * from jsonb_array_elements(coalesce(p -> 'payments', '[]')) loop
    v_count := v_count + 1;
    begin
      v_method := (x ->> 'method')::public.payment_method;
    exception when others then
      perform private.fail(format('Payment %s: choose how the customer paid.', v_count));
    end;
    if v_method is null then perform private.fail(format('Payment %s: choose how the customer paid.', v_count)); end if;
    if nullif(x ->> 'amount', '')::numeric is null or (x ->> 'amount')::numeric <= 0 then perform private.fail(format('Payment %s: enter the amount.', v_count)); end if;
    if nullif(x ->> 'paid_on', '') is null then perform private.fail(format('Payment %s: enter the date it was paid.', v_count)); end if;
    if (x ->> 'paid_on')::date > v_today then perform private.fail(format('Payment %s: the date cannot be in the future.', v_count)); end if;
    if (x ->> 'paid_on')::date < v_today - 1825 then perform private.fail(format('Payment %s: the date is more than five years ago.', v_count)); end if;
    if coalesce(x ->> 'kind', '') not in ('deposit', 'installment', 'full') then perform private.fail(format('Payment %s: choose the payment type.', v_count)); end if;
    v_ref := nullif(trim(x ->> 'reference'), '');
    if v_ref is not null and exists (select 1 from public.payments y where lower(y.reference) = lower(v_ref) and y.method = v_method and y.status in ('pending', 'confirmed')) then
      perform private.fail(format('Payment %s: a payment with this reference is already in the CRM. Check it is not a duplicate.', v_count));
    end if;
    insert into public.payments (enrollment_id, amount, paid_on, method, reference, note, receipt_path, receipt_name, receipt_mime, receipt_size,
                                 status, submitted_by, submitted_at, decided_by, decided_at, kind)
    values (v_enrollment, (x ->> 'amount')::numeric, (x ->> 'paid_on')::date, v_method, v_ref,
            coalesce(nullif(trim(x ->> 'note'), ''), 'Paid before the customer was added to the CRM'),
            nullif(x #>> '{receipt,path}', ''), nullif(x #>> '{receipt,name}', ''), nullif(x #>> '{receipt,mime}', ''), nullif(x #>> '{receipt,size}', '')::integer,
            case when v_confirm then 'confirmed' else 'pending' end::public.payment_status, me, v_past_at,
            case when v_confirm then me end, case when v_confirm then now() end, x ->> 'kind')
    returning id into v_payment;
    if v_confirm then v_paid := v_paid + (x ->> 'amount')::numeric; else v_pending := v_pending + (x ->> 'amount')::numeric; end if;
    perform private.log_activity(v_inquiry, 'payment_submitted',
      format('Past payment recorded (%s, %s): %s · %s · paid %s', x ->> 'kind', case when v_confirm then 'confirmed' else 'waiting for review' end,
             private.money((x ->> 'amount')::numeric, v_course.currency), replace(v_method::text, '_', ' '), to_char((x ->> 'paid_on')::date, 'FMDD Mon YYYY')),
      jsonb_build_object('payment_id', v_payment, 'amount', (x ->> 'amount')::numeric, 'kind', x ->> 'kind', 'existing', true));
  end loop;
  if v_paid + v_pending > v_agreed + 0.005 then
    perform private.fail(format('The payments add up to more than the agreed total (%s).', private.money(v_agreed, v_course.currency)));
  end if;

  -- ── Plan for what is left ──
  for x in select * from jsonb_array_elements(coalesce(p -> 'dues', '[]')) loop
    if nullif(x ->> 'due_on', '') is null or nullif(x ->> 'amount', '')::numeric is null or (x ->> 'amount')::numeric <= 0 then
      perform private.fail('Each planned payment needs a date and an amount.');
    end if;
    v_dues := v_dues + (x ->> 'amount')::numeric;
    insert into public.payment_dues (enrollment_id, due_on, amount, note, created_by)
    values (v_enrollment, (x ->> 'due_on')::date, (x ->> 'amount')::numeric, nullif(trim(x ->> 'note'), ''), me);
  end loop;
  if v_dues > v_agreed - v_paid - v_pending + 0.005 then
    perform private.fail(format('The planned payments add up to more than what is left (%s).', private.money(greatest(v_agreed - v_paid - v_pending, 0), v_course.currency)));
  end if;

  -- ── Support onboarding ──
  insert into public.onboardings (enrollment_id, support_owner_id, status, claimed_at, activated_at)
  values (v_enrollment, v_support, v_status::public.support_status, case when v_support is not null then now() end,
          case when v_status = 'active' then now() end)
  returning id into v_onboarding;
  insert into public.onboarding_items (onboarding_id, template_item_id, label, sort, due_at, done_at, done_by)
  select v_onboarding, t.id, t.label, t.sort, null, case when v_status = 'active' then now() end, case when v_status = 'active' then me end
    from public.checklist_template t where not t.archived;

  -- ── Teacher (optional) ──
  if p -> 'teacher' is not null and jsonb_typeof(p -> 'teacher') = 'object' and nullif(p #>> '{teacher,teacher_id}', '') is not null then
    if not exists (select 1 from public.teacher_rates r where r.id = nullif(p #>> '{teacher,rate_id}', '')::uuid
                   and r.teacher_id = (p #>> '{teacher,teacher_id}')::uuid and not r.archived) then
      perform private.fail('Choose one of the teacher''s rates.');
    end if;
    insert into public.teacher_assignments (teacher_id, rate_id, enrollment_id, subject, started_on, created_by)
    values ((p #>> '{teacher,teacher_id}')::uuid, (p #>> '{teacher,rate_id}')::uuid, v_enrollment,
            nullif(trim(p #>> '{teacher,subject}'), ''), v_enrolled, me);
  end if;

  -- ── History ──
  perform private.log_activity(v_inquiry, 'enrollment',
    format('Added as an existing customer by %s: %s · agreed total %s%s', (select full_name from public.profiles where id = me), v_course.name,
           private.money(v_agreed, v_course.currency), coalesce(' (' || v_note || ')', '')),
    jsonb_build_object('enrollment_id', v_enrollment, 'existing', true));
  if v_pending > 0 then
    insert into public.notifications (user_id, text, inquiry_id)
    select id, format('Payment to review: %s · %s', v_name, private.money(v_pending, v_course.currency)), v_inquiry
      from public.profiles where role in ('manager', 'accountant') and active and id <> me;
  end if;
  if v_support is not null and v_support <> me then
    perform private.notify(v_support, 'Customer assigned to you for onboarding: ' || v_name, v_inquiry);
  end if;
  perform private.audit(format('Added existing customer: %s (%s)', v_course.name, private.money(v_agreed, v_course.currency)), v_name,
                        jsonb_build_object('payments', v_count, 'confirmed', v_paid, 'pending', v_pending, 'planned', v_dues));

  return jsonb_build_object('inquiry_id', v_inquiry, 'enrollment_id', v_enrollment, 'contact_id', v_contact,
                            'confirmed', v_paid, 'pending', v_pending, 'planned', v_dues);
exception
  when check_violation then perform private.fail('One of the values is too long or not allowed.');
end $$;

revoke all on function public.lookup_contact_by_phone(text, text), public.add_existing_customer(jsonb) from public, anon;
grant execute on function public.lookup_contact_by_phone(text, text), public.add_existing_customer(jsonb) to authenticated;

-- Reports: customers added as existing are not new inquiries, enrollments or sales.
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
      and not i.added_as_existing  -- customers entered as existing are not new sales activity
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
      and not i.added_as_existing
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
