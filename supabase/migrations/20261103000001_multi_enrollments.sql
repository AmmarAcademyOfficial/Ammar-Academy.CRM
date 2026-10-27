-- ===== CRM changes plan 2 · Phase 1 · 28 Oct 2026 =====
-- More than one enrollment and payment per customer; the accountant sees everything and reviews it.
--   * A lead may hold several enrollments (a second course in the same program, or a course in
--     another program). Each keeps its own agreed total, payments, plan, handover and teacher.
--     enrollments.additional marks the second and later ones; enrollments.added_as_existing marks
--     those entered through Add existing customer (copied from the lead for older rows).
--   * Payments: managers, the accountant, the lead's sales owner and the customer's support owner
--     record them. A manager's or the accountant's payment is confirmed at once. One transfer can be
--     split across a customer's enrollments (payments.split_group: same reference and receipt).
--   * Handover no longer waits for confirmation: a recorded (pending or confirmed) payment that meets
--     the handover rule hands the enrollment to support. A rejected or reversed payment that takes it
--     back below the rule flags the customer for managers and support. A second enrollment goes to
--     the customer's current support owner.
--   * The accountant reads every lead and customer (with phone numbers) and the audit history, but
--     changes nothing except payments and reviews. Enrollments wait in a review queue (new, changed,
--     price differs); the accountant or a manager marks each Reviewed or Queried. Nothing waits for it.
--   * Reports and accounting use the course's program for enrollments and money.
-- Existing leads, enrollments and payments are not changed (apart from the two copied flags and the
-- review status of existing enrollments, which starts as "to review").

-- ── 1. Several enrollments per lead ──────────────────────────────────────
do $$
declare c text;
begin
  for c in
    select con.conname from pg_constraint con
     where con.conrelid = 'public.enrollments'::regclass and con.contype = 'u'
       and con.conkey = array[(select attnum from pg_attribute where attrelid = 'public.enrollments'::regclass and attname = 'inquiry_id')]::smallint[]
  loop
    execute format('alter table public.enrollments drop constraint %I', c);
  end loop;
end $$;
create index if not exists enrollments_inquiry_idx on public.enrollments (inquiry_id);

alter table public.enrollments add column if not exists additional boolean not null default false;
alter table public.enrollments add column if not exists added_as_existing boolean not null default false;
update public.enrollments e set added_as_existing = true
  from public.inquiries i where i.id = e.inquiry_id and i.added_as_existing and not e.added_as_existing;

-- Review by the accountant or a manager (never blocks anything).
alter table public.enrollments add column if not exists review_status text not null default 'to_review'
  check (review_status in ('to_review', 'reviewed', 'queried'));
alter table public.enrollments add column if not exists review_reason text not null default 'New enrollment'
  check (length(review_reason) <= 120);
alter table public.enrollments add column if not exists reviewed_by uuid references public.profiles (id);
alter table public.enrollments add column if not exists reviewed_at timestamptz;
alter table public.enrollments add column if not exists review_note text check (review_note is null or length(review_note) <= 500);
create index if not exists enrollments_review_idx on public.enrollments (created_at) where review_status <> 'reviewed';

-- One transfer split across enrollments shares a group id (same reference and receipt).
alter table public.payments add column if not exists split_group uuid;
create index if not exists payments_split_idx on public.payments (split_group) where split_group is not null;

-- ── 2. The accountant reads everything ───────────────────────────────────
create or replace function private.sees_all() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.my_role() in ('manager', 'accountant')
$$;
revoke all on function private.sees_all() from public, anon;
grant execute on function private.sees_all() to authenticated;

create or replace function private.can_see_inquiry(p_inquiry uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.inquiries i
    where i.id = p_inquiry
      and (
        private.my_role() in ('manager', 'accountant')
        or (private.my_role() = 'sales' and i.sales_owner_id = auth.uid())
      )
  ) or private.can_support_inquiry(p_inquiry)
$$;

drop policy if exists inquiry_read on public.inquiries;
create policy inquiry_read on public.inquiries for select to authenticated
  using (
    (select private.my_role()) in ('manager', 'accountant')
    or ((select private.my_role()) = 'sales' and sales_owner_id = (select auth.uid()))
    or ((select private.my_role()) = 'support' and id in (select private.my_inquiry_ids()))
  );

drop policy if exists contact_read on public.contacts;
create policy contact_read on public.contacts for select to authenticated
  using (
    (select private.my_role()) in ('manager', 'accountant')
    or exists (select 1 from public.inquiries i where i.contact_id = contacts.id)
  );

drop policy if exists inquiry_child_read on public.activities;
create policy inquiry_child_read on public.activities for select to authenticated
  using ((select private.my_role()) in ('manager', 'accountant') or inquiry_id in (select private.my_inquiry_ids()));

drop policy if exists inquiry_child_read on public.follow_ups;
create policy inquiry_child_read on public.follow_ups for select to authenticated
  using ((select private.my_role()) in ('manager', 'accountant') or inquiry_id in (select private.my_inquiry_ids()));

drop policy if exists inquiry_child_read on public.inquiry_tags;
create policy inquiry_child_read on public.inquiry_tags for select to authenticated
  using ((select private.my_role()) in ('manager', 'accountant') or inquiry_id in (select private.my_inquiry_ids()));

drop policy if exists enrollment_read on public.enrollments;
create policy enrollment_read on public.enrollments for select to authenticated
  using ((select private.my_role()) in ('manager', 'accountant') or inquiry_id in (select private.my_inquiry_ids()));

-- Custom fields: the accountant sees what managers see.
drop policy if exists field_value_read on public.field_values;
create policy field_value_read on public.field_values for select to authenticated
  using (
    ((select private.my_role()) in ('manager', 'accountant') or inquiry_id in (select private.my_inquiry_ids()))
    and exists (select 1 from public.field_definitions f where f.id = field_values.field_id
                and ((select private.my_role()) = any (f.visible_to)
                     or ((select private.my_role()) = 'accountant' and 'manager' = any (f.visible_to))))
  );

drop policy if exists manager_read on public.audit_log;
create policy manager_read on public.audit_log for select to authenticated
  using ((select private.my_role()) in ('manager', 'accountant'));

-- ── 3. Handover rule: recorded payments count ────────────────────────────
-- Same rule as src/domain/rules.ts handoverCheck, now on confirmed + pending payments, with the
-- deposit rule of the enrollment's own course program.
create or replace function private.handover_met(p_enrollment uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  t record;
  s public.app_settings;
  v_program uuid;
  r jsonb;
  v_threshold numeric;
  v_recorded numeric;
begin
  select * into t from private.enrollment_totals(p_enrollment);
  v_recorded := t.paid + t.pending;
  if v_recorded <= 0 then return false; end if;
  if v_recorded >= t.agreed - 0.005 then return true; end if;
  select * into s from public.app_settings where id = 1;
  if s.handover_trigger = 'full_payment' then return false; end if;
  select co.program_id into v_program from public.enrollments e join public.courses co on co.id = e.course_id where e.id = p_enrollment;
  r := s.deposit_rule -> v_program::text;
  if r is null or jsonb_typeof(r) <> 'object' then return false; end if;
  v_threshold := case when r ->> 'kind' = 'amount' then (r ->> 'value')::numeric else t.agreed * (r ->> 'value')::numeric / 100 end;
  return v_recorded >= v_threshold - 0.005;
end $$;

-- Creates the enrollment's onboarding, sets Enrolled, and tells support. Idempotent.
-- A second or later enrollment goes straight to the customer's current support owner.
create or replace function private.hand_over(p_enrollment uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  e public.enrollments;
  v_id uuid;
  v_name text;
  v_course text;
  v_owner uuid;
begin
  select * into e from public.enrollments where id = p_enrollment;
  insert into public.onboardings (enrollment_id) values (p_enrollment)
  on conflict (enrollment_id) do nothing
  returning id into v_id;
  if v_id is null then return null; end if; -- already handed over

  insert into public.onboarding_items (onboarding_id, template_item_id, label, sort, due_at)
  select v_id, t.id, t.label, t.sort, case when t.due_after_days is null then null else now() + make_interval(days => t.due_after_days) end
  from public.checklist_template t where not t.archived;

  if private.stage_key_of(e.inquiry_id) <> 'enrolled' then
    update public.inquiries set stage_id = (select id from public.stages where system_key = 'enrolled'), version = version + 1
    where id = e.inquiry_id;
    perform private.log_activity(e.inquiry_id, 'stage_change', null, jsonb_build_object('to', 'enrolled', 'reason', 'handover'));
  end if;
  v_name := private.contact_name(e.inquiry_id);
  select name into v_course from public.courses where id = e.course_id;

  -- The customer's current support owner, from their other courses.
  select o.support_owner_id into v_owner
    from public.onboardings o join public.enrollments x on x.id = o.enrollment_id
    join public.profiles pr on pr.id = o.support_owner_id and pr.active
   where x.inquiry_id = e.inquiry_id and x.id <> e.id and o.support_owner_id is not null
   order by o.claimed_at desc nulls last, o.created_at desc limit 1;

  if v_owner is not null then
    update public.onboardings set support_owner_id = v_owner, claimed_at = now() where id = v_id;
    perform private.log_activity(e.inquiry_id, 'handover',
      format('Handed over to customer support: %s (to the customer''s support owner)', v_course));
    perform private.notify(v_owner, format('New course for your customer: %s · %s', v_name, v_course), e.inquiry_id);
  else
    perform private.log_activity(e.inquiry_id, 'handover', format('Handed over to customer support: %s', v_course));
    insert into public.notifications (user_id, text, inquiry_id)
    select id, format('New customer ready for onboarding: %s · %s', v_name, v_course), e.inquiry_id from public.profiles where role = 'support' and active;
  end if;
  if e.original_sales_owner_id is not null then
    perform private.notify(e.original_sales_owner_id, format('Enrolled and handed over to support: %s · %s', v_name, v_course), e.inquiry_id);
  end if;
  return v_id;
end $$;
revoke all on function private.hand_over(uuid), private.handover_met(uuid) from public, anon, authenticated;

-- Flags a handed-over enrollment whose recorded payments fell below the handover rule.
create or replace function private.flag_if_below(p_enrollment uuid, p_what text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  o public.onboardings;
  e public.enrollments;
begin
  select * into o from public.onboardings where enrollment_id = p_enrollment for update;
  if not found or private.handover_met(p_enrollment) then return false; end if;
  select * into e from public.enrollments where id = p_enrollment;
  update public.onboardings set flagged_reason = format('%s on %s. Recorded payments are now below the handover rule. Check with a manager before continuing.',
    p_what, to_char(now() at time zone 'Africa/Cairo', 'DD Mon YYYY')), version = version + 1
  where id = o.id;
  insert into public.notifications (user_id, text, inquiry_id)
  select id, 'Handed-over customer flagged: ' || private.contact_name(e.inquiry_id), e.inquiry_id
    from public.profiles where active and (role = 'manager' or id = o.support_owner_id);
  return true;
end $$;
revoke all on function private.flag_if_below(uuid, text) from public, anon, authenticated;

-- ── 4. Who may record payments, change enrollments ───────────────────────
-- The lead's sales owner or a manager (sales work); the customer's support owner; the accountant
-- (payments only). Locks and returns the lead.
create or replace function private.inquiry_for_money(p_inquiry uuid, p_accountant_ok boolean)
returns public.inquiries language plpgsql security definer set search_path = '' as $$
declare
  q public.inquiries;
  v_role public.app_role := private.my_role();
begin
  if v_role = 'accountant' then
    if not p_accountant_ok then raise exception using errcode = 'CRM03', message = 'You do not have permission to do this.'; end if;
    select * into q from public.inquiries where id = p_inquiry for update;
    if not found then raise exception using errcode = 'CRM04', message = 'This record does not exist.'; end if;
    return q;
  end if;
  return private.inquiry_for_payment(p_inquiry);
end $$;
revoke all on function private.inquiry_for_money(uuid, boolean) from public, anon, authenticated;

-- ── 5. Enrollments ───────────────────────────────────────────────────────
-- p: enrollment_id? (change that one), inquiry_id, course_id, agreed_total, price_note,
--    sales_agent_id? (who is credited; new enrollments only; '' = Before the CRM / nobody).
-- Without enrollment_id: the lead's first enrollment is created, or its only one is changed (older
-- screens); a lead with several must name the one to change. add: true always creates a new one.
create or replace function public.save_enrollment(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  my public.app_role := private.require_role('manager', 'sales', 'support');
  q public.inquiries := private.inquiry_for_money((p ->> 'inquiry_id')::uuid, false);
  c public.courses;
  e public.enrollments;
  v_total numeric := nullif(p ->> 'agreed_total', '')::numeric;
  v_note text := nullif(trim(p ->> 'price_note'), '');
  v_confirmed boolean;
  v_count integer;
  v_add boolean := coalesce((p ->> 'add')::boolean, false);
  v_credit uuid;
  v_name text := private.contact_name(q.id);
begin
  select * into c from public.courses where id = (p ->> 'course_id')::uuid;
  if not found then perform private.fail('Choose the course.'); end if;
  if v_total is null or v_total <= 0 then perform private.fail('Enter the agreed total.'); end if;
  if c.price is not null and abs(v_total - c.price) > 0.005 and v_note is null then
    perform private.fail(format('The agreed total differs from the course price (%s). Add a short reason, for example a sibling discount.', private.money(c.price, c.currency)));
  end if;
  select count(*) into v_count from public.enrollments where inquiry_id = q.id;

  if nullif(p ->> 'enrollment_id', '') is not null then
    select * into e from public.enrollments where id = (p ->> 'enrollment_id')::uuid and inquiry_id = q.id for update;
    if not found then raise exception using errcode = 'CRM04', message = 'This enrollment does not belong to this customer.'; end if;
  elsif not v_add and v_count = 1 then
    select * into e from public.enrollments where inquiry_id = q.id for update;
  elsif not v_add and v_count > 1 then
    perform private.fail('This customer has several enrollments. Choose the one to change.');
  end if;

  if e.id is null then
    -- ── New enrollment ──
    if not c.active then perform private.fail('This course is closed for new enrollments.'); end if;
    -- The first enrollment follows the lead's program; later ones may be any program.
    if v_count = 0 and c.program_id <> q.program_id then perform private.fail('This course belongs to another program.'); end if;
    if p ? 'sales_agent_id' then
      v_credit := nullif(p ->> 'sales_agent_id', '')::uuid;
      if v_credit is not null and not exists (select 1 from public.profiles where id = v_credit and role in ('sales', 'manager', 'support')) then
        perform private.fail('Choose who is credited from the list.');
      end if;
    else
      v_credit := q.sales_owner_id;
    end if;
    insert into public.enrollments (inquiry_id, course_id, agreed_total, currency, price_note, original_sales_owner_id, created_by, additional,
                                    review_reason)
    values (q.id, c.id, v_total, c.currency, v_note, v_credit, auth.uid(), v_count > 0,
            case when v_count > 0 then 'Additional enrollment' else 'New enrollment' end)
    returning * into e;
    perform private.log_activity(q.id, 'enrollment',
      format('%s: %s · agreed total %s%s', case when v_count > 0 then 'Another enrollment' else 'Enrollment' end,
             c.name, private.money(v_total, c.currency), coalesce(' (' || v_note || ')', '')),
      jsonb_build_object('enrollment_id', e.id, 'course_id', c.id, 'agreed_total', v_total, 'additional', v_count > 0));
  else
    -- ── Change an enrollment ──
    if not e.additional and c.program_id <> q.program_id then
      perform private.fail('This course belongs to another program. Add it as another enrollment instead.');
    end if;
    v_confirmed := exists (select 1 from public.payments where enrollment_id = e.id and status = 'confirmed');
    if v_confirmed and my <> 'manager' then
      perform private.fail('Payments are already confirmed for this enrollment. Ask a manager to change the course or total.');
    end if;
    if v_confirmed and e.currency <> c.currency then perform private.fail('The currency cannot change after payments are confirmed.'); end if;
    if v_total < (select paid from private.enrollment_totals(e.id)) then
      perform private.fail('The agreed total cannot be less than what is already confirmed as paid.');
    end if;
    update public.enrollments set course_id = c.id, agreed_total = v_total, currency = c.currency, price_note = v_note,
      updated_at = now(), version = version + 1,
      review_status = 'to_review', reviewed_by = null, reviewed_at = null,
      review_reason = case when v_confirmed then 'Changed after payments were confirmed' else 'Changed' end
    where id = e.id;
    perform private.log_activity(q.id, 'enrollment',
      format('Enrollment changed: %s · agreed total %s%s', c.name, private.money(v_total, c.currency), coalesce(' (' || v_note || ')', '')),
      jsonb_build_object('enrollment_id', e.id, 'course_id', c.id, 'agreed_total', v_total, 'previous_total', e.agreed_total));
    if v_confirmed then
      perform private.audit(format('Changed enrollment after payments (%s → %s)', private.money(e.agreed_total, e.currency), private.money(v_total, c.currency)), v_name);
    end if;
  end if;
  -- The lead's course of interest follows its first enrollment.
  if not e.additional or v_count = 0 then
    update public.inquiries set course_id = c.id where id = q.id and course_id is distinct from c.id;
  end if;
  perform private.ensure_awaiting_payment(q.id);
  if private.handover_met(e.id) then perform private.hand_over(e.id); end if;
  return e.id;
end $$;

-- ── 6. Payments ──────────────────────────────────────────────────────────
-- One payment on one enrollment (shared by submit_payment and submit_split_payment).
-- p: enrollment_id, amount, paid_on, method, reference, note, kind (deposit | installment | full),
--    receipt: {path, name, mime, size} (verified by the server before it reaches here)
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
revoke all on function private.record_payment(jsonb, uuid) from public, anon, authenticated;

create or replace function public.submit_payment(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  return private.record_payment(p, null);
end $$;

-- One transfer split across enrollments of the same customer.
-- p: parts: [{enrollment_id, amount, kind}], paid_on, method, reference, note, receipt
create or replace function public.submit_split_payment(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_group uuid := gen_random_uuid();
  v_contact uuid;
  x jsonb;
  v_ids jsonb := '[]';
  v_n integer := 0;
begin
  if jsonb_typeof(p -> 'parts') <> 'array' or jsonb_array_length(p -> 'parts') < 2 then
    perform private.fail('Split a payment across at least two enrollments.');
  end if;
  if jsonb_array_length(p -> 'parts') > 10 then perform private.fail('Split a payment across at most 10 enrollments.'); end if;
  if (select count(distinct y ->> 'enrollment_id') from jsonb_array_elements(p -> 'parts') y) <> jsonb_array_length(p -> 'parts') then
    perform private.fail('Each enrollment can appear once in a split payment.');
  end if;
  if (select count(distinct i.contact_id) from jsonb_array_elements(p -> 'parts') y
        join public.enrollments e on e.id = nullif(y ->> 'enrollment_id', '')::uuid join public.inquiries i on i.id = e.inquiry_id)
     <> 1 then
    perform private.fail('A split payment must be for one customer''s enrollments.');
  end if;
  for x in select * from jsonb_array_elements(p -> 'parts') loop
    v_n := v_n + 1;
    v_ids := v_ids || to_jsonb(private.record_payment(
      (p - 'parts') || jsonb_build_object('enrollment_id', x ->> 'enrollment_id', 'amount', x ->> 'amount', 'kind', x ->> 'kind'), v_group));
  end loop;
  return jsonb_build_object('ids', v_ids, 'split_group', v_group);
end $$;

-- ── 7. Payment decisions: rejection can flag a handed-over customer ──────
create or replace function public.decide_payment(p_payment uuid, p_decision text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  x public.payments;
  e public.enrollments;
  t record;
  v_onb uuid;
  v_flag_cleared boolean := false;
  v_flagged boolean := false;
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
    jsonb_build_object('payment_id', x.id, 'decision', p_decision, 'enrollment_id', e.id));
  perform private.notify(x.submitted_by,
    format('Payment %s: %s · %s%s', p_decision, private.contact_name(e.inquiry_id), private.money(x.amount, e.currency), coalesce(' (' || nullif(trim(p_reason), '') || ')', '')),
    e.inquiry_id);

  if p_decision = 'confirmed' then
    if private.handover_met(e.id) then
      v_onb := private.hand_over(e.id);
      update public.onboardings set flagged_reason = null where enrollment_id = e.id and flagged_reason is not null;
      v_flag_cleared := found;
    end if;
  else
    v_flagged := private.flag_if_below(e.id, format('A payment of %s was rejected (%s)', private.money(x.amount, e.currency), trim(p_reason)));
  end if;
  select * into t from private.enrollment_totals(e.id);
  return jsonb_build_object('handed_over', v_onb is not null, 'flag_cleared', v_flag_cleared, 'flagged', v_flagged,
                            'paid', t.paid, 'balance', greatest(t.agreed - t.paid, 0));
end $$;

create or replace function public.reverse_payment(p_payment uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  x public.payments;
  e public.enrollments;
  t record;
  v_flagged boolean;
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
    jsonb_build_object('payment_id', x.id, 'decision', 'reversed', 'enrollment_id', e.id));
  perform private.audit(format('Reversed payment %s (%s)', private.money(x.amount, e.currency), trim(p_reason)), private.contact_name(e.inquiry_id));
  perform private.notify(x.submitted_by, format('Payment reversed: %s · %s', private.contact_name(e.inquiry_id), private.money(x.amount, e.currency)), e.inquiry_id);
  v_flagged := private.flag_if_below(e.id, format('A confirmed payment of %s was reversed (%s)', private.money(x.amount, e.currency), trim(p_reason)));
  select * into t from private.enrollment_totals(e.id);
  return jsonb_build_object('flagged', v_flagged, 'paid', t.paid, 'balance', greatest(t.agreed - t.paid, 0));
end $$;

-- ── 8. Review by the accountant or a manager ─────────────────────────────
-- p_status: reviewed | queried (a query needs a note; it goes to who entered it, who is credited, managers).
create or replace function public.review_enrollment(p_enrollment uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  e public.enrollments;
  v_name text;
  v_course text;
  v_me text;
begin
  perform private.require_role('manager', 'accountant');
  if p_status not in ('reviewed', 'queried') then perform private.fail('Choose Reviewed or Query.'); end if;
  if p_status = 'queried' and coalesce(trim(p_note), '') = '' then perform private.fail('Write what needs checking.'); end if;
  if length(coalesce(p_note, '')) > 500 then perform private.fail('Keep the note under 500 characters.'); end if;
  select * into e from public.enrollments where id = p_enrollment for update;
  if not found then raise exception using errcode = 'CRM04', message = 'Enrollment not found.'; end if;
  update public.enrollments set review_status = p_status, reviewed_by = auth.uid(), reviewed_at = now(), review_note = nullif(trim(p_note), '')
  where id = e.id;
  v_name := private.contact_name(e.inquiry_id);
  select name into v_course from public.courses where id = e.course_id;
  select full_name into v_me from public.profiles where id = auth.uid();
  perform private.log_activity(e.inquiry_id, 'enrollment',
    format('%s by %s: %s%s', case when p_status = 'reviewed' then 'Enrollment reviewed' else 'Enrollment queried' end, v_me, v_course,
           coalesce(' · ' || nullif(trim(p_note), ''), '')),
    jsonb_build_object('enrollment_id', e.id, 'review', p_status));
  perform private.audit(format('%s: %s%s', case when p_status = 'reviewed' then 'Reviewed enrollment' else 'Queried enrollment' end, v_course,
                               coalesce(' · ' || nullif(trim(p_note), ''), '')), v_name);
  if p_status = 'queried' then
    insert into public.notifications (user_id, text, inquiry_id)
    select distinct pr.id, format('Enrollment queried by %s: %s · %s · %s', v_me, v_name, v_course, trim(p_note)), e.inquiry_id
      from public.profiles pr
     where pr.active and pr.id <> auth.uid()
       and (pr.role = 'manager' or pr.id = e.created_by or pr.id = e.original_sales_owner_id);
  end if;
end $$;

-- What waits for review: enrollments to review or queried, and how many payments wait for confirmation.
create or replace function public.review_queue()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_role('manager', 'accountant');
  return jsonb_build_object(
    'pendingPayments', (select count(*) from public.payments where status = 'pending'),
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

revoke all on function public.save_enrollment(jsonb), public.submit_payment(jsonb), public.submit_split_payment(jsonb),
  public.decide_payment(uuid, text, text), public.reverse_payment(uuid, text),
  public.review_enrollment(uuid, text, text), public.review_queue() from public, anon;
grant execute on function public.save_enrollment(jsonb), public.submit_payment(jsonb), public.submit_split_payment(jsonb),
  public.decide_payment(uuid, text, text), public.reverse_payment(uuid, text),
  public.review_enrollment(uuid, text, text), public.review_queue() to authenticated;

-- ── 9. Downloads: the accountant may download leads too ──────────────────
create or replace function public.log_lead_export(p jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role public.app_role := private.require_role('manager', 'accountant');
  v_rows integer := coalesce((p ->> 'rows')::integer, -1);
begin
  if v_rows < 0 or v_rows > 20000 then perform private.fail('A download holds up to 20,000 leads.'); end if;
  perform private.audit('Downloaded Excel',
    'Leads · ' || v_rows || ' row' || case when v_rows = 1 then '' else 's' end
      || coalesce(' · ' || nullif(left(trim(coalesce(p ->> 'label', '')), 500), ''), ''),
    jsonb_build_object('list', 'leads', 'filters', coalesce(p -> 'filters', '{}'), 'sort', p -> 'sort', 'rows', v_rows));
end $$;


-- ── 10. Add existing customer: a person already in the CRM gets the enrollment on their record ──
create or replace function public.add_existing_customer(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  my public.app_role := private.require_role('manager', 'support');
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_contact uuid := nullif(p ->> 'contact_id', '')::uuid;
  v_known boolean := nullif(p ->> 'contact_id', '') is not null;
  v_additional boolean := false;
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

  -- ── The lead: a person already in the CRM keeps one record per student (Phase 1); otherwise a new enrolled lead ──
  if v_known then
    select i.id into v_inquiry from public.inquiries i
     where i.contact_id = v_contact and (nullif(p ->> 'inquiry_id', '') is null or i.id = (p ->> 'inquiry_id')::uuid)
       -- the same student (a different child gets their own record)
       and (v_student is null or coalesce(lower(i.student_name), '') = lower(v_student))
     order by exists (select 1 from public.enrollments x where x.inquiry_id = i.id) desc, i.created_at desc
     limit 1;
  end if;
  if v_inquiry is not null then
    v_additional := exists (select 1 from public.enrollments where inquiry_id = v_inquiry);
    if private.stage_key_of(v_inquiry) <> 'enrolled' then
      update public.inquiries set stage_id = (select id from public.stages where system_key = 'enrolled'), version = version + 1 where id = v_inquiry;
      perform private.log_activity(v_inquiry, 'stage_change', null, jsonb_build_object('to', 'enrolled', 'reason', 'existing_customer'));
    end if;
  else
    insert into public.inquiries (contact_id, program_id, student_name, stage_id, sales_owner_id, source, created_by, assigned_at,
                                  assignment_method, course_id, added_as_existing)
    values (v_contact, v_program.id, v_student, (select id from public.stages where system_key = 'enrolled'), v_sales, 'manual', me,
            case when v_sales is not null then now() end, case when v_sales is not null then 'manual' end, v_course.id, true)
    returning id into v_inquiry;
    -- Never "not opened": this customer is not a new lead for anyone.
    update public.inquiries set owner_opened_at = now(), unopened_alert_at = now() where id = v_inquiry;
  end if;

  insert into public.enrollments (inquiry_id, course_id, agreed_total, currency, price_note, original_sales_owner_id, created_by, created_at, package_hours_before,
                                  additional, added_as_existing, review_reason)
  values (v_inquiry, v_course.id, v_agreed, v_course.currency, v_note, v_sales, me,
          (v_enrolled::timestamp + time '12:00') at time zone 'Africa/Cairo', v_before,
          v_additional, true, 'Added as existing customer')
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

  return jsonb_build_object('inquiry_id', v_inquiry, 'enrollment_id', v_enrollment, 'contact_id', v_contact, 'additional', v_additional,
                            'confirmed', v_paid, 'pending', v_pending, 'planned', v_dues);
exception
  when check_violation then perform private.fail('One of the values is too long or not allowed.');
end $$;


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
                                     'course', (select string_agg(co.name, ', ' order by e.created_at) from public.enrollments e join public.courses co on co.id = e.course_id where e.inquiry_id = i.id))
                                   order by i.created_at desc)
                                   from public.inquiries i join public.programs p on p.id = i.program_id join public.stages s on s.id = i.stage_id
                                  where i.contact_id = c.id), '[]'))
            from public.contacts c where c.id = v_contact);
end $$;



-- ── 11. Enrollments list: phone numbers for the accountant, the course's program, distinct people ──
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
           coalesce(sum(x.amount) filter (where x.status = 'confirmed'), 0) as paid,
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
           case when o.id is null then 'not_handed_over' when o.flagged_reason is not null then 'flagged' else o.status::text end as status,
           e.currency, e.agreed_total as agreed, coalesce(pay.paid, 0) as paid, coalesce(pay.pending, 0) as pending,
           greatest(e.agreed_total - coalesce(pay.paid, 0), 0) as balance, pay.last_paid_on,
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
            or ('none' = any (v_payments) and b.paid = 0))
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
    'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'count', n, 'agreed', agreed, 'paid', paid, 'balance', balance, 'overdue', overdue) order by n desc)
                          from (select currency, count(*) as n, sum(agreed) as agreed, sum(paid) as paid, sum(balance) as balance, sum(overdue_left) as overdue from hit group by currency) t), '[]'),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'enrollmentId', o.enrollment_id, 'inquiryId', o.inquiry_id, 'customerName', o.customer_name, 'phone', o.phone,
        'studentName', o.student_name, 'programId', o.program_id, 'courseId', o.course_id, 'courseTypeId', o.course_type_id,
        'courseStart', o.course_start, 'enrolledAt', o.enrolled_at, 'salesAgentId', o.sales_agent_id, 'supportOwnerId', o.support_owner_id,
        'status', o.status, 'currency', o.currency, 'agreed', o.agreed, 'paid', o.paid, 'pending', o.pending, 'balance', o.balance,
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
      from ordered o join public.payments x on x.enrollment_id = o.enrollment_id where o.n <= v_size), '[]') end,
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



-- ── 12. Reports: enrollments under their course's program; additional enrollments counted; the accountant reads them ──
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
    'additionalEnrollments', (select count(*) from handed where additional),
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
           co.program_id, e.course_id, co.course_type_id, e.original_sales_owner_id, o.support_owner_id
      from public.payments p
      join public.enrollments e on e.id = p.enrollment_id
      join public.inquiries i on i.id = e.inquiry_id
      join public.contacts c on c.id = i.contact_id
      join public.courses co on co.id = e.course_id
      left join public.onboardings o on o.enrollment_id = e.id
     where p.paid_on between p_from and p_to
     order by p.paid_on desc, p.submitted_at desc;
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
             coalesce(sum(x.amount) filter (where x.status = 'confirmed'), 0) as paid,
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



revoke all on function public.add_existing_customer(jsonb), public.lookup_contact_by_phone(text, text), public.enrollments_list(jsonb),
  public.report(jsonb), public.log_lead_export(jsonb) from public, anon;
grant execute on function public.add_existing_customer(jsonb), public.lookup_contact_by_phone(text, text), public.enrollments_list(jsonb),
  public.report(jsonb), public.log_lead_export(jsonb) to authenticated;
