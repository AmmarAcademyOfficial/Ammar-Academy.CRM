-- CRM changes plan 3, release 4 (28 Oct 2026): refunds.
-- A refund records money the Academy paid back to a customer for one course. Support and sales
-- request one; managers and the accountant record it (or decline the request). A recorded refund
-- counts at once: Paid becomes paid minus refunded everywhere (course card, balances, handover rule,
-- Accounting, Customers list and Excel, Reports, sales credit).
-- Outcome: Withdraw (the customer leaves the course: future sessions removed, unpaid planned payments
-- cancelled, teacher assignment ended, support status Withdrawn) or Keep studying (the agreed total
-- drops by the refund). Reverse stays for a transfer that bounced.
-- Adds a table, a column, a support status and functions; no existing payment changes.

alter type public.support_status add value if not exists 'withdrawn';
alter table public.enrollments add column if not exists withdrawn_at timestamptz;

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments (id),
  status text not null default 'requested' check (status in ('requested', 'recorded', 'declined')),
  amount numeric(12, 2) not null check (amount > 0),
  reason text not null check (reason in ('withdrew', 'course_changed', 'overpaid', 'goodwill', 'other')),
  note text check (note is null or length(note) <= 500),
  outcome text check (outcome is null or outcome in ('withdraw', 'keep')),
  refunded_on date,
  method public.payment_method,
  reference text check (reference is null or length(reference) <= 100),
  receipt_path text, receipt_name text, receipt_mime text, receipt_size integer,
  requested_by uuid references public.profiles (id),
  requested_at timestamptz,
  recorded_by uuid references public.profiles (id),
  recorded_at timestamptz,
  declined_by uuid references public.profiles (id),
  declined_at timestamptz,
  decline_reason text check (decline_reason is null or length(decline_reason) <= 300),
  created_at timestamptz not null default now(),
  constraint refunds_recorded_complete check (status <> 'recorded'
    or (refunded_on is not null and method is not null and outcome is not null and recorded_by is not null and recorded_at is not null))
);
create index refunds_enrollment_idx on public.refunds (enrollment_id);
create index refunds_refunded_on_idx on public.refunds (refunded_on) where status = 'recorded';
create unique index refunds_one_open_request on public.refunds (enrollment_id) where status = 'requested';
alter table public.refunds enable row level security;
revoke all on public.refunds from anon, authenticated;
grant select on public.refunds to authenticated;
create policy refund_read on public.refunds for select to authenticated
  using (exists (select 1 from public.enrollments e where e.id = refunds.enrollment_id));

-- Refund lines on the lead's timeline.
alter table public.activities drop constraint activities_type_check;
alter table public.activities add constraint activities_type_check check (type in (
  'comment', 'contact_attempt', 'stage_change', 'owner_change', 'follow_up_created', 'follow_up_completed',
  'payment_submitted', 'payment_decision', 'handover', 'checklist', 'support_status', 'tag_change',
  'do_not_contact', 'imported', 'resubmitted', 'outreach_shortcut', 'field_change', 'reservation',
  'enrollment', 'support_assignment', 'support_follow_up', 'payment_plan', 'teacher', 'session', 'deleted', 'refund'
));

-- Notifications: refund requests (managers, the accountant) and refund decisions (support, sales).
insert into public.notification_rules (event, role, enabled, popup) values
  ('refund_requested', 'manager', true, true),
  ('refund_requested', 'accountant', true, true),
  ('refund_update', 'sales', true, true),
  ('refund_update', 'support', true, true),
  ('refund_update', 'manager', true, false)
on conflict (event, role) do nothing;

-- Recorded refunds of one enrollment.
create or replace function private.refunded(p_enrollment uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(amount), 0) from public.refunds where enrollment_id = p_enrollment and status = 'recorded'
$$;

create or replace function private.refund_reason_text(p_reason text) returns text
language sql immutable set search_path = '' as $$
  select case p_reason when 'withdrew' then 'Withdrew from the course' when 'course_changed' then 'Course cancelled or moved'
    when 'overpaid' then 'Paid too much' when 'goodwill' then 'Goodwill or discount' else 'Other' end
$$;

-- Support or sales ask for a refund; managers and the accountant are told and decide.
-- p: {enrollment_id, amount, reason, note}
create or replace function public.request_refund(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  my public.app_role := private.require_role('manager', 'accountant', 'sales', 'support');
  e public.enrollments;
  t record;
  v_amount numeric := nullif(p ->> 'amount', '')::numeric;
  v_reason text := p ->> 'reason';
  v_note text := nullif(trim(coalesce(p ->> 'note', '')), '');
  v_course text;
  v_id uuid;
begin
  select * into e from public.enrollments where id = nullif(p ->> 'enrollment_id', '')::uuid for update;
  if not found then raise exception using errcode = 'CRM04', message = 'Enrollment not found.'; end if;
  perform private.inquiry_for_money(e.inquiry_id, true);  -- the lead's agent, the customer's support owner, managers, the accountant
  select name into v_course from public.courses where id = e.course_id;
  if e.withdrawn_at is not null then perform private.fail('This customer has already withdrawn from this course.'); end if;
  if exists (select 1 from public.refunds where enrollment_id = e.id and status = 'requested') then
    perform private.fail('A refund for this course is already waiting for a decision.');
  end if;
  select * into t from private.enrollment_totals(e.id);
  if v_amount is null or v_amount <= 0 then perform private.fail('Enter the amount to refund.'); end if;
  if t.paid <= 0 then perform private.fail('Nothing confirmed has been paid for this course, so there is nothing to refund.'); end if;
  if v_amount > t.paid + 0.005 then
    perform private.fail(format('The refund cannot be more than what the customer paid for %s (%s confirmed).', v_course, private.money(t.paid, e.currency)));
  end if;
  if v_reason is null or v_reason not in ('withdrew', 'course_changed', 'overpaid', 'goodwill', 'other') then perform private.fail('Choose the reason for the refund.'); end if;
  if v_reason = 'other' and v_note is null then perform private.fail('Write the reason for the refund.'); end if;
  if length(coalesce(v_note, '')) > 500 then perform private.fail('Keep the note under 500 characters.'); end if;

  insert into public.refunds (enrollment_id, amount, reason, note, requested_by, requested_at)
  values (e.id, v_amount, v_reason, v_note, me, now()) returning id into v_id;
  perform private.log_activity(e.inquiry_id, 'refund',
    format('Refund requested: %s · %s · %s%s', v_course, private.money(v_amount, e.currency), private.refund_reason_text(v_reason), coalesce(' · ' || v_note, '')),
    jsonb_build_object('refund_id', v_id, 'status', 'requested', 'enrollment_id', e.id, 'amount', v_amount));
  insert into public.notifications (user_id, text, inquiry_id, kind)
  select id, format('Refund requested: %s · %s · %s', private.contact_name(e.inquiry_id), v_course, private.money(v_amount, e.currency)), e.inquiry_id, 'refund_requested'
    from public.profiles where role in ('manager', 'accountant') and active and id <> me;
  return v_id;
end $$;

-- Managers and the accountant record a refund (their own, or a request), which counts at once.
-- p: {request_id?, enrollment_id, amount, refunded_on, method, reference, receipt{path,name,mime,size}, reason, note, outcome}
create or replace function public.record_refund(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  rq public.refunds;
  e public.enrollments;
  o public.onboardings;
  t record;
  v_amount numeric := nullif(p ->> 'amount', '')::numeric;
  v_on date := nullif(p ->> 'refunded_on', '')::date;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_method public.payment_method;
  v_ref text := nullif(trim(coalesce(p ->> 'reference', '')), '');
  v_reason text := p ->> 'reason';
  v_note text := nullif(trim(coalesce(p ->> 'note', '')), '');
  v_outcome text := p ->> 'outcome';
  v_course text;
  v_name text;
  v_id uuid;
  v_sessions int := 0;
  v_dues int := 0;
  v_flagged boolean := false;
  v_what text;
begin
  perform private.require_role('manager', 'accountant');
  if nullif(p ->> 'request_id', '') is not null then
    select * into rq from public.refunds where id = (p ->> 'request_id')::uuid for update;
    if not found then raise exception using errcode = 'CRM04', message = 'Refund request not found.'; end if;
    if rq.status <> 'requested' then perform private.fail('This refund request was already decided.'); end if;
    select * into e from public.enrollments where id = rq.enrollment_id for update;
  else
    select * into e from public.enrollments where id = nullif(p ->> 'enrollment_id', '')::uuid for update;
  end if;
  if e.id is null then raise exception using errcode = 'CRM04', message = 'Enrollment not found.'; end if;
  select name into v_course from public.courses where id = e.course_id;
  v_name := private.contact_name(e.inquiry_id);
  if e.withdrawn_at is not null then perform private.fail('This customer has already withdrawn from this course.'); end if;

  begin
    v_method := (p ->> 'method')::public.payment_method;
  exception when others then
    perform private.fail('Choose how the money was paid back.');
  end;
  if v_method is null then perform private.fail('Choose how the money was paid back.'); end if;
  select * into t from private.enrollment_totals(e.id);
  if v_amount is null or v_amount <= 0 then perform private.fail('Enter the amount refunded.'); end if;
  if v_amount > t.paid + 0.005 then
    perform private.fail(format('The refund cannot be more than what the customer paid for %s (%s confirmed).', v_course, private.money(greatest(t.paid, 0), e.currency)));
  end if;
  if v_on is null then perform private.fail('Enter the date the money was paid back.'); end if;
  if v_on > v_today then perform private.fail('The refund date cannot be in the future.'); end if;
  if v_on < v_today - 365 then perform private.fail('The refund date is more than a year ago.'); end if;
  if v_method <> 'cash' and v_ref is null then perform private.fail('Enter the transfer or transaction reference.'); end if;
  if v_reason is null or v_reason not in ('withdrew', 'course_changed', 'overpaid', 'goodwill', 'other') then perform private.fail('Choose the reason for the refund.'); end if;
  if v_reason = 'other' and v_note is null then perform private.fail('Write the reason for the refund.'); end if;
  if length(coalesce(v_note, '')) > 500 then perform private.fail('Keep the note under 500 characters.'); end if;
  if v_outcome is null or v_outcome not in ('withdraw', 'keep') then perform private.fail('Choose what happens to the course: Withdraw or Keep studying.'); end if;
  if v_outcome = 'keep' and e.agreed_total - v_amount < 0 then perform private.fail('The refund is more than the agreed total.'); end if;

  if rq.id is not null then
    update public.refunds set status = 'recorded', amount = v_amount, reason = v_reason, note = v_note, outcome = v_outcome,
           refunded_on = v_on, method = v_method, reference = v_ref,
           receipt_path = nullif(p #>> '{receipt,path}', ''), receipt_name = nullif(p #>> '{receipt,name}', ''),
           receipt_mime = nullif(p #>> '{receipt,mime}', ''), receipt_size = nullif(p #>> '{receipt,size}', '')::integer,
           recorded_by = me, recorded_at = now()
     where id = rq.id returning id into v_id;
  else
    insert into public.refunds (enrollment_id, status, amount, reason, note, outcome, refunded_on, method, reference,
                                receipt_path, receipt_name, receipt_mime, receipt_size, recorded_by, recorded_at)
    values (e.id, 'recorded', v_amount, v_reason, v_note, v_outcome, v_on, v_method, v_ref,
            nullif(p #>> '{receipt,path}', ''), nullif(p #>> '{receipt,name}', ''), nullif(p #>> '{receipt,mime}', ''),
            nullif(p #>> '{receipt,size}', '')::integer, me, now())
    returning id into v_id;
  end if;

  select * into o from public.onboardings where enrollment_id = e.id for update;
  if v_outcome = 'withdraw' then
    -- The customer leaves the course.
    update public.enrollments set withdrawn_at = now(), version = version + 1, updated_at = now() where id = e.id;
    delete from public.teacher_sessions where enrollment_id = e.id and status = 'scheduled' and starts_at > now();
    get diagnostics v_sessions = row_count;
    delete from public.payment_dues where id in (select d.id from private.dues_state(e.id) d where d.status <> 'paid');
    get diagnostics v_dues = row_count;
    update public.teacher_assignments set ended_on = greatest(started_on, v_today)
     where enrollment_id = e.id and (ended_on is null or ended_on > v_today);
    if o.id is not null then
      update public.onboardings set status = 'withdrawn', flagged_reason = null, version = version + 1 where id = o.id;
    end if;
    v_what := 'Withdrew from the course'
      || case when v_sessions > 0 then format(', %s future session%s removed', v_sessions, case when v_sessions = 1 then '' else 's' end) else '' end
      || case when v_dues > 0 then format(', %s planned payment%s cancelled', v_dues, case when v_dues = 1 then '' else 's' end) else '' end;
  else
    -- Keep studying: the agreed total drops by the refund (for example a late discount).
    update public.enrollments set agreed_total = agreed_total - v_amount, version = version + 1, updated_at = now() where id = e.id;
    v_what := format('Keeps studying; agreed total now %s', private.money(e.agreed_total - v_amount, e.currency));
    v_flagged := private.flag_if_below(e.id, format('A refund of %s was recorded (%s)', private.money(v_amount, e.currency), private.refund_reason_text(v_reason)));
  end if;

  perform private.log_activity(e.inquiry_id, 'refund',
    format('Refund recorded: %s · %s · %s · %s%s', v_course, private.money(v_amount, e.currency), private.refund_reason_text(v_reason), v_what, coalesce(' · ' || v_note, '')),
    jsonb_build_object('refund_id', v_id, 'status', 'recorded', 'enrollment_id', e.id, 'amount', v_amount, 'outcome', v_outcome));
  perform private.audit(format('Recorded refund %s (%s)', private.money(v_amount, e.currency), private.refund_reason_text(v_reason)), v_name || ' · ' || v_course,
    jsonb_build_object('refund_id', v_id, 'enrollment_id', e.id, 'outcome', v_outcome, 'sessions_removed', v_sessions, 'dues_cancelled', v_dues));
  -- The support owner, the credited agent and whoever asked are told.
  insert into public.notifications (user_id, text, inquiry_id, kind)
  select distinct u, format('Refund recorded: %s · %s · %s%s', v_name, v_course, private.money(v_amount, e.currency),
                            case when v_outcome = 'withdraw' then ' · withdrew' else '' end), e.inquiry_id, 'refund_update'
    from unnest(array[o.support_owner_id, e.original_sales_owner_id, rq.requested_by]) u
   where u is not null and u <> me and exists (select 1 from public.profiles pr where pr.id = u and pr.active);
  return jsonb_build_object('id', v_id, 'withdrawn', v_outcome = 'withdraw', 'sessionsRemoved', v_sessions, 'duesCancelled', v_dues, 'flagged', v_flagged);
end $$;

-- A request that will not be paid. The person who asked is told why.
create or replace function public.decline_refund(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  rq public.refunds;
  e public.enrollments;
  v_course text;
begin
  perform private.require_role('manager', 'accountant');
  if coalesce(trim(p_reason), '') = '' then perform private.fail('Add the reason for declining.'); end if;
  if length(trim(p_reason)) > 300 then perform private.fail('Keep the reason under 300 characters.'); end if;
  select * into rq from public.refunds where id = p_id for update;
  if not found then raise exception using errcode = 'CRM04', message = 'Refund request not found.'; end if;
  if rq.status <> 'requested' then perform private.fail('This refund request was already decided.'); end if;
  select * into e from public.enrollments where id = rq.enrollment_id;
  select name into v_course from public.courses where id = e.course_id;
  update public.refunds set status = 'declined', declined_by = auth.uid(), declined_at = now(), decline_reason = trim(p_reason) where id = rq.id;
  perform private.log_activity(e.inquiry_id, 'refund',
    format('Refund request declined: %s · %s · %s', v_course, private.money(rq.amount, e.currency), trim(p_reason)),
    jsonb_build_object('refund_id', rq.id, 'status', 'declined', 'enrollment_id', e.id));
  perform private.audit(format('Declined refund request %s (%s)', private.money(rq.amount, e.currency), trim(p_reason)), private.contact_name(e.inquiry_id) || ' · ' || v_course);
  if rq.requested_by is not null and rq.requested_by <> auth.uid() then
    insert into public.notifications (user_id, text, inquiry_id, kind)
    values (rq.requested_by, format('Refund declined: %s · %s · %s', private.contact_name(e.inquiry_id), v_course, trim(p_reason)), e.inquiry_id, 'refund_update');
  end if;
end $$;

-- Accounting → Payments and Overview: recorded refunds by the date paid back.
create or replace function public.accounting_refunds(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_finance();
  if p_from is null or p_to is null or p_to < p_from then perform private.fail('Choose a valid date range.'); end if;
  if p_to - p_from > 400 then perform private.fail('Choose a range of at most 400 days.'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', r.id, 'refundedOn', r.refunded_on, 'amount', r.amount, 'currency', e.currency, 'method', r.method, 'reference', r.reference,
      'hasReceipt', r.receipt_path is not null, 'receiptName', r.receipt_name, 'reason', r.reason, 'note', r.note, 'outcome', r.outcome,
      'recordedBy', r.recorded_by, 'recordedAt', r.recorded_at, 'requestedBy', r.requested_by,
      'enrollmentId', e.id, 'inquiryId', e.inquiry_id, 'customerName', c.name, 'studentName', i.student_name,
      'programId', co.program_id, 'courseId', e.course_id, 'courseTypeId', co.course_type_id, 'courseName', co.name,
      'salesAgentId', e.original_sales_owner_id, 'supportOwnerId', o.support_owner_id)
      order by r.refunded_on desc, r.recorded_at desc)
    from public.refunds r
    join public.enrollments e on e.id = r.enrollment_id
    join public.inquiries i on i.id = e.inquiry_id
    join public.contacts c on c.id = i.contact_id
    join public.courses co on co.id = e.course_id
    left join public.onboardings o on o.enrollment_id = e.id
   where r.status = 'recorded' and r.refunded_on between p_from and p_to), '[]'::jsonb);
end $$;

-- ── Money totals: refunds count everywhere ──

-- Paid is confirmed payments minus recorded refunds (release 4).
create or replace function private.enrollment_totals(p_enrollment uuid, out agreed numeric, out paid numeric, out pending numeric)
language sql stable security definer set search_path = '' as $$
  select e.agreed_total,
         coalesce((select sum(p.amount) from public.payments p where p.enrollment_id = e.id and p.status = 'confirmed'), 0) - private.refunded(e.id),
         coalesce((select sum(p.amount) from public.payments p where p.enrollment_id = e.id and p.status = 'pending'), 0)
  from public.enrollments e
  where e.id = p_enrollment
$$;

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
           coalesce(sum(p.amount) filter (where p.status = 'confirmed' and p.submitted_at >= x.plan_start), 0) - private.refunded(x.enrollment_id) as pool,
           coalesce(sum(p.amount) filter (where p.status = 'confirmed'), 0) - private.refunded(x.enrollment_id) as paid_all
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

create or replace function private.record_payment(p jsonb, p_split uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  my public.app_role := private.require_role('manager', 'sales', 'support', 'accountant');
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
  v_confirm boolean := my in ('manager', 'accountant');
  v_course text;
  v_id uuid;
begin
  select * into e from public.enrollments where id = nullif(p ->> 'enrollment_id', '')::uuid;
  if not found then raise exception using errcode = 'CRM04', message = 'Enrollment not found.'; end if;
  q := private.inquiry_for_money(e.inquiry_id, true);
  if e.withdrawn_at is not null then
    perform private.fail('This customer withdrew from this course, so no more payments can be recorded for it.');
  end if;
  perform 1 from public.enrollments where id = e.id for update; -- one submission at a time per enrollment
  select name into v_course from public.courses where id = e.course_id;

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
    perform private.fail(format('This is more than the remaining balance of %s (%s, including payments waiting for review). If the price changed, update the agreed total first, or add another enrollment.',
      v_course, private.money(greatest(v_remaining, 0), e.currency)));
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
    select 1 from public.payments x
    where lower(x.reference) = lower(v_ref) and x.method = v_method and x.status in ('pending', 'confirmed')
      and (p_split is null or x.split_group is distinct from p_split)
  ) then
    perform private.fail('A payment with this reference was already submitted. Check it is not a duplicate.');
  end if;

  insert into public.payments (enrollment_id, amount, paid_on, method, reference, note, receipt_path, receipt_name, receipt_mime, receipt_size,
                               submitted_by, kind, split_group, status, decided_by, decided_at)
  values (e.id, v_amount, v_paid_on, v_method, v_ref, nullif(trim(p ->> 'note'), ''),
          nullif(p #>> '{receipt,path}', ''), nullif(p #>> '{receipt,name}', ''), nullif(p #>> '{receipt,mime}', ''),
          nullif(p #>> '{receipt,size}', '')::integer, me, v_kind, p_split,
          case when v_confirm then 'confirmed' else 'pending' end::public.payment_status,
          case when v_confirm then me end, case when v_confirm then now() end)
  returning id into v_id;

  perform private.log_activity(q.id, 'payment_submitted',
    format('Payment %s (%s): %s · %s · %s%s', case when v_confirm then 'recorded and confirmed' else 'submitted' end,
           case v_kind when 'full' then 'full payment' else v_kind end, v_course,
           private.money(v_amount, e.currency), replace(v_method::text, '_', ' '), coalesce(' · ref ' || v_ref, '')),
    jsonb_build_object('payment_id', v_id, 'amount', v_amount, 'kind', v_kind, 'enrollment_id', e.id, 'confirmed', v_confirm, 'split', p_split is not null));
  if not v_confirm then
    insert into public.notifications (user_id, text, inquiry_id)
    select id, format('Payment to review: %s · %s · %s', private.contact_name(q.id), v_course, private.money(v_amount, e.currency)), q.id
    from public.profiles where role in ('manager', 'accountant') and active and id <> me;
  end if;
  perform private.ensure_awaiting_payment(q.id);
  -- Handover does not wait for confirmation.
  if private.handover_met(e.id) then
    perform private.hand_over(e.id);
    if v_confirm then
      update public.onboardings set flagged_reason = null, version = version + 1 where enrollment_id = e.id and flagged_reason is not null;
    end if;
  end if;
  return v_id;
end $$;

create or replace function public.accounting_customers()
returns table (
  enrollment_id uuid, inquiry_id uuid, customer_name text, student_name text,
  program_id uuid, course_id uuid, course_type_id uuid, currency text,
  agreed_total numeric, paid numeric, pending numeric, enrolled_at timestamptz, handed_over_at timestamptz,
  sales_agent_id uuid, support_owner_id uuid,
  next_due_on date, next_due_left numeric, next_due_status text, overdue_left numeric, overdue_since date)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_finance();
  return query
    with dues as (select * from private.dues_state(null)),
    pay as (
      select x.enrollment_id,
             coalesce(sum(x.amount) filter (where x.status = 'confirmed'), 0) - private.refunded(x.enrollment_id) as paid,
             coalesce(sum(x.amount) filter (where x.status = 'pending'), 0) as pending
        from public.payments x group by x.enrollment_id
    )
    select e.id, e.inquiry_id, c.name, i.student_name,
           co.program_id, e.course_id, co.course_type_id, e.currency,
           e.agreed_total, coalesce(pay.paid, 0), coalesce(pay.pending, 0), e.created_at, o.created_at,
           e.original_sales_owner_id, o.support_owner_id,
           nd.due_on, nd.amount - nd.covered, nd.status,
           coalesce((select sum(d.amount - d.covered) from dues d where d.enrollment_id = e.id and d.status = 'overdue'), 0),
           (select min(d.due_on) from dues d where d.enrollment_id = e.id and d.status = 'overdue')
      from public.enrollments e
      join public.inquiries i on i.id = e.inquiry_id
      join public.contacts c on c.id = i.contact_id
      join public.courses co on co.id = e.course_id
      left join public.onboardings o on o.enrollment_id = e.id
      left join pay on pay.enrollment_id = e.id
      left join lateral (select d.* from dues d where d.enrollment_id = e.id and d.status <> 'paid' order by d.due_on limit 1) nd on true
     order by c.name;
end $$;

create or replace function public.enrollments_list(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role public.app_role := private.require_role('manager', 'accountant', 'support');
  v_me uuid := auth.uid();
  f jsonb := coalesce(p -> 'filters', '{}');
  v_search text := nullif(trim(coalesce(f ->> 'search', '')), '');
  v_digits text;
  v_programs uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(f -> 'programIds', '[]')) x), '{}');
  v_types uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(f -> 'courseTypeIds', '[]')) x), '{}');
  v_courses uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(f -> 'courseIds', '[]')) x), '{}');
  v_teachers uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(f -> 'teacherIds', '[]')) x), '{}');
  v_sales text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(f -> 'salesAgentIds', '[]')) x), '{}');
  v_support text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(f -> 'supportOwnerIds', '[]')) x), '{}');
  v_statuses text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(f -> 'statuses', '[]')) x), '{}');
  v_payments text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(f -> 'paymentStates', '[]')) x), '{}');
  v_currency text := nullif(f ->> 'currency', '');
  v_enrolled_from date := nullif(f ->> 'enrolledFrom', '')::date;
  v_enrolled_to date := nullif(f ->> 'enrolledTo', '')::date;
  v_start_from date := nullif(f ->> 'startFrom', '')::date;
  v_start_to date := nullif(f ->> 'startTo', '')::date;
  v_scope text := coalesce(nullif(p ->> 'scope', ''), case when v_role = 'support' then 'mine' else 'all' end);
  v_sort text := coalesce(p #>> '{sort,key}', 'enrolled');
  v_desc boolean := coalesce(p #>> '{sort,dir}', 'desc') = 'desc';
  v_size integer := least(greatest(coalesce((p ->> 'pageSize')::integer, 50), 5), 100);
  v_page integer := greatest(coalesce((p ->> 'page')::integer, 0), 0);
  v_result jsonb;
  v_export boolean := coalesce((p ->> 'export')::boolean, false);
  v_total integer;
begin
  if v_scope not in ('mine', 'all') then perform private.fail('Choose whose customers to show.'); end if;
  if v_export then
    perform private.require_role('manager', 'accountant');  -- support and sales cannot download
    v_size := 20000;
    v_page := 0;
  end if;
  if v_sort not in ('customer', 'course', 'enrolled', 'start', 'sales', 'support', 'paid', 'balance', 'next_due', 'overdue', 'last_paid') then v_sort := 'enrolled'; end if;
  if v_search is not null then v_digits := nullif(regexp_replace(v_search, '\D', '', 'g'), ''); end if;

  with dues as (select * from private.dues_state(null)),
  pay as (
    select x.enrollment_id,
           coalesce(sum(x.amount) filter (where x.status = 'confirmed'), 0) - private.refunded(x.enrollment_id) as paid,
           private.refunded(x.enrollment_id) as refunded,
           coalesce(sum(x.amount) filter (where x.status = 'pending'), 0) as pending,
           max(x.paid_on) filter (where x.status = 'confirmed') as last_paid_on
      from public.payments x group by x.enrollment_id
  ),
  teach as (
    select e.id as enrollment_id, array_agg(distinct t.id) as teacher_ids, string_agg(distinct t.full_name, ', ') as teacher_names
      from public.enrollments e
      join public.teacher_assignments a on (a.enrollment_id = e.id or a.course_id = e.course_id) and a.ended_on is null
      join public.teachers t on t.id = a.teacher_id
     group by e.id
  ),
  base as (
    select e.id as enrollment_id, e.inquiry_id, c.name as customer_name,
           c.phone_normalized as phone,
           i.student_name, co.program_id, e.course_id, co.course_type_id, co.start_date as course_start,
           e.created_at as enrolled_at, (e.created_at at time zone 'Africa/Cairo')::date as enrolled_on,
           e.original_sales_owner_id as sales_agent_id, o.support_owner_id,
           case when e.withdrawn_at is not null then 'withdrawn' when o.id is null then 'not_handed_over' when o.flagged_reason is not null then 'flagged' else o.status::text end as status,
           e.currency, e.agreed_total as agreed, coalesce(pay.paid, 0) as paid, coalesce(pay.pending, 0) as pending,
           coalesce(pay.refunded, 0) as refunded,
           case when e.withdrawn_at is not null then 0 else greatest(e.agreed_total - coalesce(pay.paid, 0), 0) end as balance, pay.last_paid_on,
           nd.due_on as next_due_on, nd.amount - nd.covered as next_due_left,
           coalesce((select sum(d.amount - d.covered) from dues d where d.enrollment_id = e.id and d.status = 'overdue'), 0) as overdue_left,
           coalesce(teach.teacher_ids, '{}') as teacher_ids, teach.teacher_names,
           private.package_hours(e.id) as package_hours,
           case when private.package_hours(e.id) is not null then private.package_used(e.id) end as package_used,
           c.phone_normalized as search_phone, c.phone_secondary_normalized as search_phone2,
           e.added_as_existing, e.additional, i.contact_id
      from public.enrollments e
      join public.inquiries i on i.id = e.inquiry_id
      join public.contacts c on c.id = i.contact_id
      join public.courses co on co.id = e.course_id
      left join public.onboardings o on o.enrollment_id = e.id
      left join pay on pay.enrollment_id = e.id
      left join teach on teach.enrollment_id = e.id
      left join lateral (select d.* from dues d where d.enrollment_id = e.id and d.status <> 'paid' order by d.due_on limit 1) nd on true
  ),
  hit as (
    select * from base b
     where (v_role <> 'support' or v_scope = 'all' or b.support_owner_id = v_me
            or (b.support_owner_id is null and b.status <> 'not_handed_over'))  -- 'mine' = mine + the unclaimed queue, as before
       and (v_search is null or b.customer_name ilike '%' || replace(replace(v_search, '%', '\%'), '_', '\_') || '%'
            or coalesce(b.student_name, '') ilike '%' || replace(replace(v_search, '%', '\%'), '_', '\_') || '%'
            or (v_digits is not null and length(v_digits) >= 3
                and (b.search_phone like '%' || v_digits || '%' or coalesce(b.search_phone2, '') like '%' || v_digits || '%')))
       and (cardinality(v_programs) = 0 or b.program_id = any (v_programs))
       and (cardinality(v_types) = 0 or b.course_type_id = any (v_types))
       and (cardinality(v_courses) = 0 or b.course_id = any (v_courses))
       and (cardinality(v_teachers) = 0 or b.teacher_ids && v_teachers)
       and (cardinality(v_sales) = 0 or b.sales_agent_id::text = any (v_sales) or ('none' = any (v_sales) and b.sales_agent_id is null))
       and (cardinality(v_support) = 0 or b.support_owner_id::text = any (v_support) or ('none' = any (v_support) and b.support_owner_id is null))
       and (cardinality(v_statuses) = 0 or b.status = any (v_statuses))
       and (cardinality(v_payments) = 0
            or ('paid' = any (v_payments) and b.balance = 0)
            or ('balance' = any (v_payments) and b.balance > 0)
            or ('overdue' = any (v_payments) and b.overdue_left > 0)
            or ('pending' = any (v_payments) and b.pending > 0)
            or ('none' = any (v_payments) and b.paid = 0)
            or ('refunded' = any (v_payments) and b.refunded > 0))
       and (v_currency is null or b.currency = v_currency)
       and (v_enrolled_from is null or b.enrolled_on >= v_enrolled_from)
       and (v_enrolled_to is null or b.enrolled_on <= v_enrolled_to)
       and (v_start_from is null or b.course_start >= v_start_from)
       and (v_start_to is null or b.course_start <= v_start_to)
  ),
  ordered as (
    select h.*, row_number() over (order by
      case when not v_desc then case v_sort when 'customer' then lower(h.customer_name) when 'course' then (select lower(name) from public.courses where id = h.course_id)
        when 'sales' then (select lower(full_name) from public.profiles where id = h.sales_agent_id)
        when 'support' then (select lower(full_name) from public.profiles where id = h.support_owner_id) end end asc nulls last,
      case when v_desc then case v_sort when 'customer' then lower(h.customer_name) when 'course' then (select lower(name) from public.courses where id = h.course_id)
        when 'sales' then (select lower(full_name) from public.profiles where id = h.sales_agent_id)
        when 'support' then (select lower(full_name) from public.profiles where id = h.support_owner_id) end end desc nulls last,
      case when not v_desc then case v_sort when 'paid' then h.paid when 'balance' then h.balance when 'overdue' then h.overdue_left end end asc nulls last,
      case when v_desc then case v_sort when 'paid' then h.paid when 'balance' then h.balance when 'overdue' then h.overdue_left end end desc nulls last,
      case when not v_desc then case v_sort when 'enrolled' then h.enrolled_on when 'start' then h.course_start when 'next_due' then h.next_due_on when 'last_paid' then h.last_paid_on end end asc nulls last,
      case when v_desc then case v_sort when 'enrolled' then h.enrolled_on when 'start' then h.course_start when 'next_due' then h.next_due_on when 'last_paid' then h.last_paid_on end end desc nulls last,
      h.enrolled_at desc, h.enrollment_id) as n
      from hit h
  )
  select jsonb_build_object(
    'total', (select count(*) from hit),
    'people', (select count(distinct contact_id) from hit),
    'page', v_page, 'pageSize', v_size, 'scope', v_scope,
    'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'count', n, 'agreed', agreed, 'paid', paid, 'refunded', refunded, 'balance', balance, 'overdue', overdue) order by n desc)
                          from (select currency, count(*) as n, sum(agreed) as agreed, sum(paid) as paid, sum(refunded) as refunded, sum(balance) as balance, sum(overdue_left) as overdue from hit group by currency) t), '[]'),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'enrollmentId', o.enrollment_id, 'inquiryId', o.inquiry_id, 'customerName', o.customer_name, 'phone', o.phone,
        'studentName', o.student_name, 'programId', o.program_id, 'courseId', o.course_id, 'courseTypeId', o.course_type_id,
        'courseStart', o.course_start, 'enrolledAt', o.enrolled_at, 'salesAgentId', o.sales_agent_id, 'supportOwnerId', o.support_owner_id,
        'status', o.status, 'currency', o.currency, 'agreed', o.agreed, 'paid', o.paid, 'pending', o.pending, 'refunded', o.refunded, 'balance', o.balance,
        'lastPaidOn', o.last_paid_on, 'nextDueOn', o.next_due_on, 'nextDueLeft', o.next_due_left, 'overdueLeft', o.overdue_left,
        'teacherIds', to_jsonb(o.teacher_ids), 'teacherNames', o.teacher_names, 'packageHours', o.package_hours, 'packageUsed', o.package_used,
        'enrolledOn', o.enrolled_on, 'addedAsExisting', o.added_as_existing, 'additional', o.additional,
        'programName', (select name from public.programs where id = o.program_id),
        'courseName', (select name from public.courses where id = o.course_id),
        'courseTypeName', (select name from public.course_types where id = o.course_type_id),
        'salesAgentName', (select full_name from public.profiles where id = o.sales_agent_id),
        'supportOwnerName', (select full_name from public.profiles where id = o.support_owner_id)) order by o.n)
      from ordered o where o.n > v_page * v_size and o.n <= (v_page + 1) * v_size), '[]'),
    -- Export mode only: every payment and planned payment of the exported enrollments, in list order.
    'payments', case when v_export then coalesce((select jsonb_agg(jsonb_build_object(
        'enrollmentId', o.enrollment_id, 'customerName', o.customer_name, 'phone', o.phone, 'studentName', o.student_name,
        'courseName', (select name from public.courses where id = o.course_id), 'currency', o.currency,
        'paidOn', x.paid_on, 'amount', x.amount, 'kind', x.kind, 'method', x.method, 'reference', x.reference, 'status', x.status,
        'submittedBy', (select full_name from public.profiles where id = x.submitted_by), 'submittedAt', x.submitted_at,
        'decidedBy', (select full_name from public.profiles where id = x.decided_by), 'decidedAt', x.decided_at,
        'salesAgentName', (select full_name from public.profiles where id = o.sales_agent_id))
        order by o.n, x.paid_on, x.submitted_at, x.id)
      from ordered o
      join (select p2.enrollment_id, p2.id, p2.paid_on, p2.amount, p2.kind, p2.method::text as method, p2.reference, p2.status::text as status,
                   p2.submitted_by, p2.submitted_at, p2.decided_by, p2.decided_at
              from public.payments p2
            union all
            select r.enrollment_id, r.id, r.refunded_on, -r.amount, 'refund', r.method::text, r.reference, 'refunded',
                   coalesce(r.requested_by, r.recorded_by), coalesce(r.requested_at, r.recorded_at), r.recorded_by, r.recorded_at
              from public.refunds r where r.status = 'recorded') x on x.enrollment_id = o.enrollment_id
     where o.n <= v_size), '[]') end,
    'plan', case when v_export then coalesce((select jsonb_agg(jsonb_build_object(
        'enrollmentId', o.enrollment_id, 'customerName', o.customer_name, 'phone', o.phone, 'studentName', o.student_name,
        'courseName', (select name from public.courses where id = o.course_id), 'currency', o.currency,
        'dueOn', d.due_on, 'amount', d.amount, 'covered', d.covered, 'status', d.status, 'note', d.note)
        order by o.n, d.due_on, d.id)
      from ordered o join dues d on d.enrollment_id = o.enrollment_id where o.n <= v_size), '[]') end
  ) into v_result;

  if v_export then
    v_total := (v_result ->> 'total')::integer;
    if v_total > 20000 then
      perform private.fail(format('%s customers match. A download holds up to 20,000; narrow the filters and download in parts.', v_total));
    end if;
    perform private.audit('Downloaded Excel',
      'Enrollments · ' || v_total || ' row' || case when v_total = 1 then '' else 's' end
        || coalesce(' · ' || nullif(left(trim(coalesce(p ->> 'label', '')), 500), ''), ''),
      jsonb_build_object('list', 'enrollments', 'filters', f, 'scope', v_scope, 'sort', p -> 'sort', 'rows', v_total,
        'payments', jsonb_array_length(v_result -> 'payments'), 'planned', jsonb_array_length(v_result -> 'plan')));
  end if;
  return v_result;
end $$;

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
  perform private.require_role('manager', 'accountant');
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
  enr as (  -- enrollments in scope with their course (the course's program)
    select e.*, c.program_id, c.name as course_name, c.course_type_id
    from public.enrollments e
    join public.courses c on c.id = e.course_id
    where (v_program is null or c.program_id = v_program)
      and (v_type is null or c.course_type_id = v_type)
      and not e.added_as_existing
  ),
  handed as (  -- enrollments handed over to support in range (one per enrollment)
    select enr.*, o.created_at as handed_at, o.claimed_at, o.activated_at, o.support_owner_id
    from enr join public.onboardings o on o.enrollment_id = enr.id
    where o.created_at >= v_from and o.created_at < v_to
  ),
  conf as (  -- confirmed in range, net of refunds recorded in range; pending, rejected and reversed excluded
    select pay.amount, enr.currency, enr.course_id, enr.course_name, enr.course_type_id, enr.original_sales_owner_id, pay.decided_at
    from public.payments pay join enr on enr.id = pay.enrollment_id
    where pay.status = 'confirmed' and pay.decided_at >= v_from and pay.decided_at < v_to
    union all
    select -r.amount, enr.currency, enr.course_id, enr.course_name, enr.course_type_id, enr.original_sales_owner_id, r.recorded_at
    from public.refunds r join enr on enr.id = r.enrollment_id
    where r.status = 'recorded' and r.recorded_at >= v_from and r.recorded_at < v_to
  ),
  refunded as (
    select r.amount, enr.currency, r.outcome, r.enrollment_id
    from public.refunds r join enr on enr.id = r.enrollment_id
    where r.status = 'recorded' and r.recorded_at >= v_from and r.recorded_at < v_to
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
    'additionalEnrollments', (select count(*) from handed where additional),
    'confirmed', (select coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'amount', amount, 'count', n) order by currency), '[]'::jsonb)
                  from (select currency, sum(amount) as amount, count(*) filter (where amount > 0) as n from conf group by currency) x),
    'refunds', (select coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'amount', amount, 'count', n) order by currency), '[]'::jsonb)
                from (select currency, sum(amount) as amount, count(*) as n from refunded group by currency) x),
    'withdrawals', (select count(distinct enrollment_id) from refunded where outcome = 'withdraw'),
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

create or replace function public.review_queue()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_role('manager', 'accountant');
  return jsonb_build_object(
    'pendingPayments', (select count(*) from public.payments where status = 'pending'),
    'refundRequests', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'enrollmentId', e.id, 'inquiryId', e.inquiry_id, 'customerName', c.name, 'phone', c.phone_normalized,
        'courseName', co.name, 'currency', e.currency, 'amount', r.amount, 'reason', r.reason, 'note', r.note,
        'requestedBy', (select full_name from public.profiles where id = r.requested_by), 'requestedAt', r.requested_at,
        'paid', t.paid, 'agreed', e.agreed_total) order by r.requested_at)
      from public.refunds r
      join public.enrollments e on e.id = r.enrollment_id
      join public.inquiries i on i.id = e.inquiry_id
      join public.contacts c on c.id = i.contact_id
      join public.courses co on co.id = e.course_id
      cross join lateral private.enrollment_totals(e.id) t
     where r.status = 'requested'), '[]'),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'enrollmentId', e.id, 'inquiryId', e.inquiry_id, 'customerName', c.name, 'phone', c.phone_normalized,
        'studentName', i.student_name, 'courseName', co.name, 'programName', pg.name, 'currency', e.currency,
        'agreed', e.agreed_total, 'price', co.price, 'priceNote', e.price_note,
        'priceDiffers', co.price is not null and abs(co.price - e.agreed_total) > 0.005 and co.currency = e.currency,
        'additional', e.additional, 'addedAsExisting', e.added_as_existing, 'createdAt', e.created_at,
        'createdBy', (select full_name from public.profiles where id = e.created_by),
        'salesAgentName', (select full_name from public.profiles where id = e.original_sales_owner_id),
        'paid', t.paid, 'pending', t.pending,
        'reason', e.review_reason, 'status', e.review_status, 'note', e.review_note,
        'reviewedBy', (select full_name from public.profiles where id = e.reviewed_by), 'reviewedAt', e.reviewed_at)
        order by e.review_status = 'queried' desc, e.updated_at desc, e.created_at desc)
      from public.enrollments e
      join public.inquiries i on i.id = e.inquiry_id
      join public.contacts c on c.id = i.contact_id
      join public.courses co on co.id = e.course_id
      join public.programs pg on pg.id = co.program_id
      cross join lateral private.enrollment_totals(e.id) t
     where e.review_status <> 'reviewed'), '[]'),
    'recent', coalesce((select jsonb_agg(x order by x ->> 'reviewedAt' desc) from (
        select jsonb_build_object('enrollmentId', e.id, 'inquiryId', e.inquiry_id, 'customerName', c.name, 'courseName', co.name,
               'reviewedBy', (select full_name from public.profiles where id = e.reviewed_by), 'reviewedAt', e.reviewed_at, 'note', e.review_note) as x
          from public.enrollments e
          join public.inquiries i on i.id = e.inquiry_id
          join public.contacts c on c.id = i.contact_id
          join public.courses co on co.id = e.course_id
         where e.review_status = 'reviewed' and e.reviewed_at > now() - interval '30 days'
         order by e.reviewed_at desc limit 30) r), '[]'));
end $$;

create or replace function private.notification_kind(p_text text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_text like 'New lead assigned: %' or p_text like 'Lead assigned to you: %' or p_text like 'Lead reassigned to you: %' then 'lead_assigned'
    when p_text like 'Returning customer assigned to you:%' then 'returning_customer'
    when p_text like 'Returning customer %' then 'previous_agent_inactive'
    when p_text like 'Submitted the form again: %' then 'form_resubmitted'
    when p_text like 'Enrolled and handed over to support: %' then 'handed_over'
    when p_text like 'Payment to review: %' then 'payment_to_review'
    when p_text like 'Refund requested: %' then 'refund_requested'
    when p_text like 'Refund %' then 'refund_update'
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

-- ── Deleted items: refunds go with their enrollment ──

create or replace function private.deleted_tables()
returns text[] language sql immutable set search_path = '' as $$
  select array['teachers', 'teacher_rates', 'teacher_rate_amounts',
               'contacts', 'inquiries', 'inquiry_tags', 'activities', 'follow_ups', 'field_values',
               'enrollments', 'onboardings', 'onboarding_items', 'support_follow_ups',
               'payments', 'refunds', 'payment_dues', 'teacher_assignments', 'teacher_sessions']
$$;

create or replace function private.collect_deleted(p_contacts uuid[], p_inquiries uuid[], p_enrollments uuid[], p_payments uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_inq uuid[];
  v_enr uuid[];
  v_onb uuid[];
  d jsonb := '{}'::jsonb;
begin
  v_inq := array(select id from public.inquiries where id = any (p_inquiries) or contact_id = any (p_contacts));
  v_enr := array(select id from public.enrollments where id = any (p_enrollments) or inquiry_id = any (v_inq));
  v_onb := array(select id from public.onboardings where enrollment_id = any (v_enr));
  d := jsonb_build_object(
    'contacts',           (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.contacts x where id = any (p_contacts)),
    'inquiries',          (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]') from public.inquiries x where id = any (v_inq)),
    'inquiry_tags',       (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.inquiry_tags x where inquiry_id = any (v_inq)),
    'activities',         (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]') from public.activities x where inquiry_id = any (v_inq)),
    'follow_ups',         (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.follow_ups x where inquiry_id = any (v_inq)),
    'field_values',       (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.field_values x where inquiry_id = any (v_inq)),
    'enrollments',        (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]') from public.enrollments x where id = any (v_enr)),
    'onboardings',        (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.onboardings x where id = any (v_onb)),
    'onboarding_items',   (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.onboarding_items x where onboarding_id = any (v_onb)),
    'support_follow_ups', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.support_follow_ups x where onboarding_id = any (v_onb)),
    'payments',           (select coalesce(jsonb_agg(to_jsonb(x) order by x.submitted_at), '[]') from public.payments x where enrollment_id = any (v_enr) or id = any (p_payments)),
    'refunds',            (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.refunds x where enrollment_id = any (v_enr)),
    'payment_dues',       (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.payment_dues x where enrollment_id = any (v_enr)),
    'teacher_assignments',(select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.teacher_assignments x where enrollment_id = any (v_enr)),
    'teacher_sessions',   (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.teacher_sessions x where enrollment_id = any (v_enr)),
    -- Links kept outside the snapshot rows: the Google Sheets ledger and Needs Review items.
    'sheet_rows',         (select coalesce(jsonb_agg(jsonb_build_object('connection_id', connection_id, 'row_key', row_key, 'inquiry_id', inquiry_id)), '[]')
                             from public.sheet_rows where inquiry_id = any (v_inq)),
    'review_items',       (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'inquiry_id', inquiry_id)), '[]')
                             from public.review_items where inquiry_id = any (v_inq)));
  return d;
end $$;

create or replace function public.delete_record(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_kind text := p ->> 'kind';
  v_id uuid := (p ->> 'id')::uuid;
  v_reason text := trim(coalesce(p ->> 'reason', ''));
  v jsonb;
  d jsonb;
  v_rec uuid;
  v_flagged boolean := false;
  v_inq uuid[];
  v_enr uuid[];
begin
  perform private.require_delete_role(v_kind);
  if v_id is null then perform private.fail('Choose what to delete.'); end if;
  if v_reason = '' then perform private.fail('Add the reason for deleting.'); end if;
  if length(v_reason) > 500 then perform private.fail('Keep the reason under 500 characters.'); end if;
  -- Lock the record so two people cannot delete it at once.
  if v_kind = 'payment' then perform 1 from public.payments where id = v_id for update;
  elsif v_kind = 'enrollment' then perform 1 from public.enrollments where id = v_id for update;
  elsif v_kind = 'lead' then perform 1 from public.inquiries where id = v_id for update;
  elsif v_kind = 'customer' then perform 1 from public.contacts where id = v_id for update;
  elsif v_kind = 'teacher' then perform 1 from public.teachers where id = v_id for update;
  elsif v_kind = 'rate' then perform 1 from public.teacher_rates where id = v_id for update;
  end if;
  v := private.deletion_plan(v_kind, v_id);
  d := v -> 'data';
  -- A teacher or rate already used keeps its history: Not active or Archive instead.
  if (v ->> 'used')::boolean then
    perform private.fail(format('%s is already used (%s), so deleting would erase who taught and what was paid. %s instead.',
      v ->> 'label', v ->> 'linked', case when v_kind = 'teacher' then 'Set the teacher to Not active' else 'Archive the rate' end));
  end if;
  if v ->> 'closedMonth' is not null then
    perform private.fail(format('This has sessions in a closed salary month (%s), so it cannot be deleted. A manager can reopen the month in Accounting → Teachers, then delete it.',
      v ->> 'closedMonth'));
  end if;
  if (v ->> 'needsTyped')::boolean and coalesce(p ->> 'confirm', '') <> 'DELETE' then
    perform private.fail('This includes confirmed money. Type DELETE to confirm.');
  end if;

  insert into public.deleted_records (kind, record_id, inquiry_id, enrollment_id, label, summary, reason, data, deleted_by)
  values (v_kind, v_id, (v ->> 'inquiryId')::uuid, (v ->> 'enrollmentId')::uuid, v ->> 'label', v ->> 'summary', v_reason, d, auth.uid())
  returning id into v_rec;

  -- The Google Sheets ledger keeps its rows (so the lead is not imported again) without the link.
  v_inq := array(select (x ->> 'id')::uuid from jsonb_array_elements(d -> 'inquiries') x);
  v_enr := array(select (x ->> 'id')::uuid from jsonb_array_elements(d -> 'enrollments') x);
  update public.sheet_rows set inquiry_id = null where inquiry_id = any (v_inq);
  update public.review_items set inquiry_id = null where inquiry_id = any (v_inq);
  -- Remove the live rows, children first.
  delete from public.teacher_sessions where enrollment_id = any (v_enr);
  delete from public.teacher_assignments where enrollment_id = any (v_enr);
  delete from public.payment_dues where enrollment_id = any (v_enr);
  delete from public.refunds where enrollment_id = any (v_enr);
  delete from public.payments where enrollment_id = any (v_enr) or id in (select (x ->> 'id')::uuid from jsonb_array_elements(d -> 'payments') x);
  delete from public.onboardings where enrollment_id = any (v_enr);   -- its checklist and follow-ups go with it
  delete from public.enrollments where id = any (v_enr);
  delete from public.inquiries where id = any (v_inq);                -- tags, timeline, follow-ups, fields and notifications go with it
  delete from public.contacts where id in (select (x ->> 'id')::uuid from jsonb_array_elements(d -> 'contacts') x);
  delete from public.teacher_rates where id in (select (x ->> 'id')::uuid from jsonb_array_elements(d -> 'teacher_rates') x);   -- with their amounts
  delete from public.teachers where id in (select (x ->> 'id')::uuid from jsonb_array_elements(d -> 'teachers') x);

  -- On the lead's timeline (when the lead stays) and in the audit history.
  if v_kind in ('payment', 'enrollment') then
    perform private.log_activity((v ->> 'inquiryId')::uuid, 'deleted',
      format('%s deleted: %s · %s', initcap(v_kind), v ->> 'label', v_reason), jsonb_build_object('deleted_record_id', v_rec, 'kind', v_kind));
  end if;
  if v_kind = 'payment' then
    v_flagged := private.flag_if_below((v ->> 'enrollmentId')::uuid,
      format('A payment of %s was deleted (%s)', v ->> 'amount', v_reason));
  end if;
  perform private.audit(format('Deleted %s (%s)', v_kind, v_reason), v ->> 'label',
    jsonb_build_object('deleted_record_id', v_rec, 'kind', v_kind, 'record_id', v_id, 'summary', v ->> 'summary', 'confirmed', v -> 'confirmed'));
  return jsonb_build_object('id', v_rec, 'summary', v ->> 'summary', 'flagged', v_flagged);
end $$;

revoke all on function private.refunded(uuid), private.refund_reason_text(text) from public, anon, authenticated;
revoke all on function public.request_refund(jsonb), public.record_refund(jsonb), public.decline_refund(uuid, text), public.accounting_refunds(date, date) from public, anon;
grant execute on function public.request_refund(jsonb), public.record_refund(jsonb), public.decline_refund(uuid, text), public.accounting_refunds(date, date) to authenticated;
