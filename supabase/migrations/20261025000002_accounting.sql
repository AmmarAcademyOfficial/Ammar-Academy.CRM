-- ===== Accounting plan · Phase 2b · 22 Oct 2026 =====
-- The Accounting section and the accountant role (added in 20261025000001):
--   * Accountants confirm, reject and reverse payments, and are told about payments to review and
--     overdue payments. They never get row access to leads or contacts (no phone numbers): every
--     accounting screen reads through the functions below, which return names and amounts only.
--   * accounting_payments: every payment paid in a date range, with customer, course and people.
--   * accounting_customers: every enrollment with agreed total, paid, pending, balance left and
--     its payment plan position.
-- Additive: functions and notification rules; existing behaviour for other roles is unchanged.

-- ── Who may read finance ─────────────────────────────────────────────────
create or replace function private.require_finance() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_role('manager', 'accountant');
end $$;

-- ── Payment decisions: managers and accountants ─────────────────────────
create or replace function public.decide_payment(p_payment uuid, p_decision text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  x public.payments;
  e public.enrollments;
  t record;
  v_onb uuid;
  v_flag_cleared boolean := false;
begin
  perform private.require_role('manager', 'accountant');
  select * into x from public.payments where id = p_payment for update;
  if not found then raise exception using errcode = 'CRM04', message = 'Payment not found.'; end if;
  if x.status <> 'pending' then perform private.fail('This payment was already ' || x.status::text || '.'); end if;
  if p_decision not in ('confirmed', 'rejected') then perform private.fail('Choose confirm or reject.'); end if;
  if p_decision = 'rejected' and coalesce(trim(p_reason), '') = '' then perform private.fail('Add a reason so the agent knows what to fix.'); end if;
  select * into e from public.enrollments where id = x.enrollment_id for update;

  update public.payments set status = p_decision::public.payment_status, decided_by = auth.uid(), decided_at = now(),
    decision_reason = nullif(trim(p_reason), '')
  where id = x.id;
  perform private.log_activity(e.inquiry_id, 'payment_decision',
    format('Payment %s: %s%s', p_decision, private.money(x.amount, e.currency), coalesce(' · ' || nullif(trim(p_reason), ''), '')),
    jsonb_build_object('payment_id', x.id, 'decision', p_decision));
  perform private.notify(x.submitted_by,
    format('Payment %s: %s · %s%s', p_decision, private.contact_name(e.inquiry_id), private.money(x.amount, e.currency), coalesce(' (' || nullif(trim(p_reason), '') || ')', '')),
    e.inquiry_id);

  if p_decision = 'confirmed' then
    if private.handover_met(e.id) then
      v_onb := private.hand_over(e.id);
      -- A later confirmation can restore a customer flagged after a reversal.
      update public.onboardings set flagged_reason = null where enrollment_id = e.id and flagged_reason is not null;
      v_flag_cleared := found;
    end if;
  end if;
  select * into t from private.enrollment_totals(e.id);
  return jsonb_build_object('handed_over', v_onb is not null, 'flag_cleared', v_flag_cleared, 'paid', t.paid, 'balance', greatest(t.agreed - t.paid, 0));
end $$;

create or replace function public.reverse_payment(p_payment uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  x public.payments;
  e public.enrollments;
  o public.onboardings;
  t record;
  v_flagged boolean := false;
begin
  perform private.require_role('manager', 'accountant');
  if coalesce(trim(p_reason), '') = '' then perform private.fail('Add the reason for the reversal.'); end if;
  select * into x from public.payments where id = p_payment for update;
  if not found then raise exception using errcode = 'CRM04', message = 'Payment not found.'; end if;
  if x.status <> 'confirmed' then perform private.fail('Only confirmed payments can be reversed.'); end if;
  select * into e from public.enrollments where id = x.enrollment_id for update;
  update public.payments set status = 'reversed', reversed_by = auth.uid(), reversed_at = now(), reversal_reason = trim(p_reason)
  where id = x.id;
  perform private.log_activity(e.inquiry_id, 'payment_decision',
    format('Payment reversed: %s · %s', private.money(x.amount, e.currency), trim(p_reason)),
    jsonb_build_object('payment_id', x.id, 'decision', 'reversed'));
  perform private.audit(format('Reversed payment %s (%s)', private.money(x.amount, e.currency), trim(p_reason)), private.contact_name(e.inquiry_id));
  perform private.notify(x.submitted_by, format('Payment reversed: %s · %s', private.contact_name(e.inquiry_id), private.money(x.amount, e.currency)), e.inquiry_id);

  select * into o from public.onboardings where enrollment_id = e.id for update;
  if found and not private.handover_met(e.id) then
    update public.onboardings set flagged_reason = format('A confirmed payment of %s was reversed on %s (%s). Confirmed payments are now below the handover rule. Check with a manager before continuing.',
      private.money(x.amount, e.currency), to_char(now() at time zone 'Africa/Cairo', 'DD Mon YYYY'), trim(p_reason)), version = version + 1
    where id = o.id;
    v_flagged := true;
    insert into public.notifications (user_id, text, inquiry_id)
    select id, 'Handed-over customer flagged after a payment reversal: ' || private.contact_name(e.inquiry_id), e.inquiry_id
    from public.profiles where active and (role = 'manager' or id = o.support_owner_id);
  end if;
  select * into t from private.enrollment_totals(e.id);
  return jsonb_build_object('flagged', v_flagged, 'paid', t.paid, 'balance', greatest(t.agreed - t.paid, 0));
end $$;

-- Managers and accountants are told about a payment to review.
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
  from public.profiles where role in ('manager', 'accountant') and active and id <> auth.uid();
  perform private.ensure_awaiting_payment(q.id);
  return v_id;
end $$;

-- Overdue payment alerts also go to accountants.
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
       where u.active and (u.id = v_contact or u.role in ('manager', 'accountant'));
      update public.payment_dues set overdue_notified_at = p_at where id = rec.id;
      v_overdue := v_overdue + 1;
    end loop;
  end if;

  return jsonb_build_object('unopened', v_unopened, 'reminders', v_reminders, 'payments_due_soon', v_due_soon, 'payments_overdue', v_overdue);
end $$;

insert into public.notification_rules (event, role, enabled, popup) values
  ('payment_to_review', 'accountant', true, true),
  ('payment_overdue', 'accountant', true, false)
on conflict (event, role) do nothing;

-- ── Accounting reads ─────────────────────────────────────────────────────
-- Every payment the customer paid between p_from and p_to (Cairo dates), any status.
create or replace function public.accounting_payments(p_from date, p_to date)
returns table (
  id uuid, paid_on date, amount numeric, currency text, kind text, method text, status text, reference text,
  has_receipt boolean, receipt_name text, note text,
  submitted_by uuid, submitted_at timestamptz, decided_by uuid, decided_at timestamptz, decision_reason text,
  reversed_by uuid, reversed_at timestamptz, reversal_reason text,
  enrollment_id uuid, inquiry_id uuid, customer_name text, student_name text,
  program_id uuid, course_id uuid, course_type_id uuid, sales_agent_id uuid, support_owner_id uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_finance();
  if p_from is null or p_to is null or p_to < p_from then perform private.fail('Choose a valid date range.'); end if;
  if p_to - p_from > 400 then perform private.fail('Choose a range of at most 400 days.'); end if;
  return query
    select p.id, p.paid_on, p.amount, e.currency, p.kind, p.method::text, p.status::text, p.reference,
           p.receipt_path is not null, p.receipt_name, p.note,
           p.submitted_by, p.submitted_at, p.decided_by, p.decided_at, p.decision_reason,
           p.reversed_by, p.reversed_at, p.reversal_reason,
           e.id, e.inquiry_id, c.name, i.student_name,
           i.program_id, e.course_id, co.course_type_id, e.original_sales_owner_id, o.support_owner_id
      from public.payments p
      join public.enrollments e on e.id = p.enrollment_id
      join public.inquiries i on i.id = e.inquiry_id
      join public.contacts c on c.id = i.contact_id
      join public.courses co on co.id = e.course_id
      left join public.onboardings o on o.enrollment_id = e.id
     where p.paid_on between p_from and p_to
     order by p.paid_on desc, p.submitted_at desc;
end $$;

-- Every enrollment with what is paid, pending and left, and its payment plan position.
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
             coalesce(sum(x.amount) filter (where x.status = 'confirmed'), 0) as paid,
             coalesce(sum(x.amount) filter (where x.status = 'pending'), 0) as pending
        from public.payments x group by x.enrollment_id
    )
    select e.id, e.inquiry_id, c.name, i.student_name,
           i.program_id, e.course_id, co.course_type_id, e.currency,
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

-- A payment's receipt file, for finance staff (who have no row access to payments).
create or replace function public.accounting_receipt(p_payment uuid)
returns table (receipt_path text, receipt_mime text, receipt_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_finance();
  return query select p.receipt_path, p.receipt_mime, p.receipt_name from public.payments p where p.id = p_payment;
end $$;

revoke all on function public.accounting_payments(date, date) from public, anon;
grant execute on function public.accounting_payments(date, date) to authenticated;
revoke all on function public.accounting_customers() from public, anon;
grant execute on function public.accounting_customers() to authenticated;
revoke all on function public.accounting_receipt(uuid) from public, anon;
grant execute on function public.accounting_receipt(uuid) to authenticated;
revoke all on function private.require_finance() from public, anon;
