-- Ammar Academy CRM · Phase 4 · payments and customer support onboarding
--
-- Rules (approved in Phases 0–1):
--   * An enrollment links an inquiry to a course with an agreed total. The
--     course price is the default; a different price needs a written reason.
--   * Agents submit payments (amount, date, method, reference, receipt).
--     Only payments a manager confirms count. Pending, rejected and reversed
--     never count toward totals.
--   * When confirmed payments meet the handover rule (qualifying deposit per
--     program, or full payment), the customer is handed over: exactly one
--     onboarding record per enrollment, stage set to Enrolled, support staff
--     notified. Enrolled can only be reached this way.
--   * Support staff see the unclaimed queue and their own customers. "Assign
--     to Me" is atomic: two people clicking at once cannot both get it.
--   * Reversing a confirmed payment recalculates totals; if the customer was
--     already handed over and no longer meets the rule, the onboarding is
--     kept and flagged for review (never silently deleted).

-- ── Types ────────────────────────────────────────────────────────────────

create type public.payment_method as enum ('bank_transfer', 'instapay', 'mobile_wallet', 'cash', 'card', 'other');
create type public.payment_status as enum ('pending', 'confirmed', 'rejected', 'reversed');
create type public.support_status as enum ('new_customer', 'onboarding', 'active');

alter table public.activities drop constraint activities_type_check;
alter table public.activities add constraint activities_type_check check (type in (
  'comment', 'contact_attempt', 'stage_change', 'owner_change', 'follow_up_created', 'follow_up_completed',
  'payment_submitted', 'payment_decision', 'handover', 'checklist', 'support_status', 'tag_change',
  'do_not_contact', 'imported', 'resubmitted', 'outreach_shortcut', 'field_change', 'reservation',
  'enrollment', 'support_assignment', 'support_follow_up'
));

-- ── Tables ───────────────────────────────────────────────────────────────

create table public.enrollments (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null unique references public.inquiries (id),
  course_id uuid not null references public.courses (id),
  agreed_total numeric(12, 2) not null check (agreed_total > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  price_note text check (price_note is null or length(price_note) <= 300),
  original_sales_owner_id uuid references public.profiles (id),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments (id),
  amount numeric(12, 2) not null check (amount > 0),
  paid_on date not null,
  method public.payment_method not null,
  reference text check (reference is null or length(reference) <= 100),
  note text check (note is null or length(note) <= 1000),
  receipt_path text check (receipt_path is null or receipt_path ~ '^receipts/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$'),
  receipt_name text check (receipt_name is null or length(receipt_name) <= 200),
  receipt_mime text check (receipt_mime is null or receipt_mime in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  receipt_size integer check (receipt_size is null or receipt_size between 1 and 10485760),
  status public.payment_status not null default 'pending',
  submitted_by uuid not null references public.profiles (id),
  submitted_at timestamptz not null default now(),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  decision_reason text check (decision_reason is null or length(decision_reason) <= 300),
  reversed_by uuid references public.profiles (id),
  reversed_at timestamptz,
  reversal_reason text check (reversal_reason is null or length(reversal_reason) <= 300)
);
create index payments_enrollment_idx on public.payments (enrollment_id);
create index payments_pending_idx on public.payments (submitted_at) where status = 'pending';

create table public.checklist_template (
  id uuid primary key default gen_random_uuid(),
  label text not null check (length(trim(label)) between 1 and 120),
  sort integer not null default 0,
  due_after_days integer check (due_after_days is null or due_after_days between 0 and 365),
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.onboardings (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null unique references public.enrollments (id), -- one per enrollment
  support_owner_id uuid references public.profiles (id),
  status public.support_status not null default 'new_customer',
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  activated_at timestamptz,
  flagged_reason text,
  version integer not null default 1
);
create index onboardings_owner_idx on public.onboardings (support_owner_id);
create index onboardings_unclaimed_idx on public.onboardings (created_at) where support_owner_id is null;

create table public.onboarding_items (
  onboarding_id uuid not null references public.onboardings (id) on delete cascade,
  template_item_id uuid not null references public.checklist_template (id),
  label text not null,
  sort integer not null,
  due_at timestamptz,
  done_at timestamptz,
  done_by uuid references public.profiles (id),
  primary key (onboarding_id, template_item_id)
);

-- Kept apart from sales follow-ups so support work never shows in an agent's lists.
create table public.support_follow_ups (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references public.onboardings (id) on delete cascade,
  owner_id uuid references public.profiles (id),
  due_at timestamptz not null,
  note text not null check (length(trim(note)) between 1 and 300),
  status public.follow_up_status not null default 'open',
  completed_at timestamptz,
  completed_by uuid references public.profiles (id),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index support_follow_ups_open_idx on public.support_follow_ups (owner_id, due_at) where status = 'open';

-- ── Visibility ───────────────────────────────────────────────────────────

-- Support staff may see a customer that was handed over and is unclaimed or theirs.
create or replace function private.can_support_inquiry(p_inquiry uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.my_role() = 'support' and exists (
    select 1 from public.enrollments e join public.onboardings o on o.enrollment_id = e.id
    where e.inquiry_id = p_inquiry and (o.support_owner_id is null or o.support_owner_id = auth.uid())
  )
$$;

create or replace function private.can_see_inquiry(p_inquiry uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.inquiries i
    where i.id = p_inquiry
      and (
        private.my_role() = 'manager'
        or (private.my_role() = 'sales' and i.sales_owner_id = auth.uid())
      )
  ) or private.can_support_inquiry(p_inquiry)
$$;

-- Sales work (stages, outcomes, payments) stays with the sales owner and managers; support reads only.
create or replace function private.can_work_inquiry(p_inquiry uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.inquiries i
    where i.id = p_inquiry
      and (private.my_role() = 'manager' or (private.my_role() = 'sales' and i.sales_owner_id = auth.uid()))
  )
$$;

-- Support owner of this onboarding, or a manager.
create or replace function private.can_work_onboarding(p_onboarding uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.my_role() = 'manager'
      or (private.my_role() = 'support' and exists (
            select 1 from public.onboardings o where o.id = p_onboarding and o.support_owner_id = auth.uid()))
$$;

drop policy inquiry_read on public.inquiries;
create policy inquiry_read on public.inquiries for select to authenticated
  using (
    (select private.my_role()) = 'manager'
    or ((select private.my_role()) = 'sales' and sales_owner_id = (select auth.uid()))
    or private.can_support_inquiry(id)
  );

alter table public.enrollments enable row level security;
alter table public.payments enable row level security;
alter table public.checklist_template enable row level security;
alter table public.onboardings enable row level security;
alter table public.onboarding_items enable row level security;
alter table public.support_follow_ups enable row level security;

revoke all on public.enrollments, public.payments, public.checklist_template, public.onboardings,
  public.onboarding_items, public.support_follow_ups from anon, authenticated;
grant select on public.enrollments, public.payments, public.checklist_template, public.onboardings,
  public.onboarding_items, public.support_follow_ups to authenticated;

create policy enrollment_read on public.enrollments for select to authenticated
  using (private.can_see_inquiry(inquiry_id));
create policy payment_read on public.payments for select to authenticated
  using (exists (select 1 from public.enrollments e where e.id = payments.enrollment_id));
create policy staff_read on public.checklist_template for select to authenticated
  using ((select private.my_role()) is not null);
create policy onboarding_read on public.onboardings for select to authenticated
  using (exists (select 1 from public.enrollments e where e.id = onboardings.enrollment_id));
create policy onboarding_item_read on public.onboarding_items for select to authenticated
  using (exists (select 1 from public.onboardings o where o.id = onboarding_items.onboarding_id));
create policy support_follow_up_read on public.support_follow_ups for select to authenticated
  using (exists (select 1 from public.onboardings o where o.id = support_follow_ups.onboarding_id));

-- ── Totals and the handover rule ─────────────────────────────────────────

create or replace function private.enrollment_totals(p_enrollment uuid, out agreed numeric, out paid numeric, out pending numeric)
language sql stable security definer set search_path = '' as $$
  select e.agreed_total,
         coalesce(sum(p.amount) filter (where p.status = 'confirmed'), 0),
         coalesce(sum(p.amount) filter (where p.status = 'pending'), 0)
  from public.enrollments e left join public.payments p on p.enrollment_id = e.id
  where e.id = p_enrollment
  group by e.agreed_total
$$;

-- Same rule as src/domain/rules.ts handoverCheck: full payment always qualifies; otherwise the
-- program's qualifying deposit (an amount, or a percent of the agreed total) when the setting is
-- "qualifying_deposit". With no deposit rule set, only full payment hands over.
create or replace function private.handover_met(p_enrollment uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  t record;
  s public.app_settings;
  v_program uuid;
  r jsonb;
  v_threshold numeric;
begin
  select * into t from private.enrollment_totals(p_enrollment);
  if t.paid <= 0 then return false; end if;
  if t.paid >= t.agreed then return true; end if;
  select * into s from public.app_settings where id = 1;
  if s.handover_trigger = 'full_payment' then return false; end if;
  select i.program_id into v_program from public.enrollments e join public.inquiries i on i.id = e.inquiry_id where e.id = p_enrollment;
  r := s.deposit_rule -> v_program::text;
  if r is null or jsonb_typeof(r) <> 'object' then return false; end if;
  v_threshold := case when r ->> 'kind' = 'amount' then (r ->> 'value')::numeric else t.agreed * (r ->> 'value')::numeric / 100 end;
  return t.paid >= v_threshold;
end $$;

create or replace function private.money(p_amount numeric, p_currency text) returns text
language sql immutable set search_path = '' as $$
  select to_char(p_amount, 'FM999,999,990.##') || ' ' || p_currency
$$;

-- Moves an open inquiry forward to Awaiting Payment (never backwards).
create or replace function private.ensure_awaiting_payment(p_inquiry uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if private.stage_key_of(p_inquiry) in ('new', 'contacting', 'qualified') then
    update public.inquiries set stage_id = (select id from public.stages where system_key = 'awaiting_payment'), version = version + 1
    where id = p_inquiry;
    perform private.log_activity(p_inquiry, 'stage_change', null, jsonb_build_object('to', 'awaiting_payment', 'reason', 'payment'));
  end if;
end $$;

-- Creates the single onboarding record, sets Enrolled, and tells support. Idempotent.
create or replace function private.hand_over(p_enrollment uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  e public.enrollments;
  v_id uuid;
  v_name text;
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
  perform private.log_activity(e.inquiry_id, 'handover', 'Handed over to customer support');
  insert into public.notifications (user_id, text, inquiry_id)
  select id, 'New customer ready for onboarding: ' || v_name, e.inquiry_id from public.profiles where role = 'support' and active;
  if e.original_sales_owner_id is not null then
    perform private.notify(e.original_sales_owner_id, 'Enrolled and handed over to support: ' || v_name, e.inquiry_id);
  end if;
  return v_id;
end $$;

revoke all on function private.hand_over(uuid), private.ensure_awaiting_payment(uuid) from public, anon, authenticated;

-- ── Enrollments and payments ─────────────────────────────────────────────

-- p: inquiry_id, course_id, agreed_total, price_note
create or replace function public.save_enrollment(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  my public.app_role := private.require_role('manager', 'sales');
  q public.inquiries := private.inquiry_for_work((p ->> 'inquiry_id')::uuid);
  c public.courses;
  e public.enrollments;
  v_total numeric := nullif(p ->> 'agreed_total', '')::numeric;
  v_note text := nullif(trim(p ->> 'price_note'), '');
  v_confirmed boolean;
begin
  select * into c from public.courses where id = (p ->> 'course_id')::uuid;
  if not found then perform private.fail('Choose the course.'); end if;
  if c.program_id <> q.program_id then perform private.fail('This course belongs to another program.'); end if;
  if v_total is null or v_total <= 0 then perform private.fail('Enter the agreed total.'); end if;
  if c.price is not null and v_total <> c.price and v_note is null then
    perform private.fail(format('The agreed total differs from the course price (%s). Add a short reason, for example a sibling discount.', private.money(c.price, c.currency)));
  end if;

  select * into e from public.enrollments where inquiry_id = q.id for update;
  if not found then
    if not c.active then perform private.fail('This course is closed for new enrollments.'); end if;
    insert into public.enrollments (inquiry_id, course_id, agreed_total, currency, price_note, original_sales_owner_id, created_by)
    values (q.id, c.id, v_total, c.currency, v_note, q.sales_owner_id, auth.uid())
    returning * into e;
    perform private.log_activity(q.id, 'enrollment',
      format('Enrollment: %s · agreed total %s%s', c.name, private.money(v_total, c.currency), coalesce(' (' || v_note || ')', '')),
      jsonb_build_object('course_id', c.id, 'agreed_total', v_total));
  else
    v_confirmed := exists (select 1 from public.payments where enrollment_id = e.id and status = 'confirmed');
    if v_confirmed and my <> 'manager' then
      perform private.fail('Payments are already confirmed for this enrollment. Ask a manager to change the course or total.');
    end if;
    if v_confirmed and e.currency <> c.currency then perform private.fail('The currency cannot change after payments are confirmed.'); end if;
    if v_total < (select paid from private.enrollment_totals(e.id)) then
      perform private.fail('The agreed total cannot be less than what is already confirmed as paid.');
    end if;
    update public.enrollments set course_id = c.id, agreed_total = v_total, currency = c.currency, price_note = v_note,
      updated_at = now(), version = version + 1
    where id = e.id;
    perform private.log_activity(q.id, 'enrollment',
      format('Enrollment changed: %s · agreed total %s%s', c.name, private.money(v_total, c.currency), coalesce(' (' || v_note || ')', '')),
      jsonb_build_object('course_id', c.id, 'agreed_total', v_total, 'previous_total', e.agreed_total));
    if v_confirmed then
      perform private.audit(format('Changed enrollment after payments (%s → %s)', private.money(e.agreed_total, e.currency), private.money(v_total, c.currency)),
        private.contact_name(q.id));
    end if;
  end if;
  update public.inquiries set course_id = c.id where id = q.id and course_id is distinct from c.id;
  perform private.ensure_awaiting_payment(q.id);
  -- A lower total may already be met by confirmed payments.
  if private.handover_met(e.id) then perform private.hand_over(e.id); end if;
  return e.id;
end $$;

-- p: enrollment_id, amount, paid_on, method, reference, note,
--    receipt: {path, name, mime, size} (verified by the server before it reaches here)
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
  v_id uuid;
begin
  perform private.require_role('manager', 'sales');
  select * into e from public.enrollments where id = (p ->> 'enrollment_id')::uuid;
  if not found then raise exception using errcode = 'CRM04', message = 'Enrollment not found.'; end if;
  q := private.inquiry_for_work(e.inquiry_id);
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
  if v_amount > t.agreed - t.paid - t.pending + 0.005 then
    perform private.fail(format('This is more than the remaining balance (%s, including payments waiting for review). If the price changed, update the agreed total first.',
      private.money(greatest(t.agreed - t.paid - t.pending, 0), e.currency)));
  end if;
  if v_ref is not null and exists (
    select 1 from public.payments x join public.enrollments ee on ee.id = x.enrollment_id
    where lower(x.reference) = lower(v_ref) and x.method = v_method and x.status in ('pending', 'confirmed')
  ) then
    perform private.fail('A payment with this reference was already submitted. Check it is not a duplicate.');
  end if;

  insert into public.payments (enrollment_id, amount, paid_on, method, reference, note, receipt_path, receipt_name, receipt_mime, receipt_size, submitted_by)
  values (e.id, v_amount, v_paid_on, v_method, v_ref, nullif(trim(p ->> 'note'), ''),
          nullif(p #>> '{receipt,path}', ''), nullif(p #>> '{receipt,name}', ''), nullif(p #>> '{receipt,mime}', ''),
          nullif(p #>> '{receipt,size}', '')::integer, auth.uid())
  returning id into v_id;

  perform private.log_activity(q.id, 'payment_submitted',
    format('Payment submitted: %s · %s%s', private.money(v_amount, e.currency), replace(v_method::text, '_', ' '), coalesce(' · ref ' || v_ref, '')),
    jsonb_build_object('payment_id', v_id, 'amount', v_amount));
  insert into public.notifications (user_id, text, inquiry_id)
  select id, format('Payment to review: %s · %s', private.contact_name(q.id), private.money(v_amount, e.currency)), q.id
  from public.profiles where role = 'manager' and active and id <> auth.uid();
  perform private.ensure_awaiting_payment(q.id);
  return v_id;
end $$;

-- Manager confirms or rejects a pending payment. Returns {handed_over, paid, balance}.
create or replace function public.decide_payment(p_payment uuid, p_decision text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  x public.payments;
  e public.enrollments;
  t record;
  v_onb uuid;
  v_flag_cleared boolean := false;
begin
  perform private.require_role('manager');
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
  perform private.require_role('manager');
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

-- ── Support onboarding ───────────────────────────────────────────────────

-- "Assign to Me": only one person can win.
create or replace function public.claim_onboarding(p_onboarding uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_inquiry uuid;
  v_owner text;
begin
  perform private.require_role('support');
  update public.onboardings set support_owner_id = auth.uid(), claimed_at = now(),
    status = case when status = 'new_customer' then 'onboarding'::public.support_status else status end, version = version + 1
  where id = p_onboarding and support_owner_id is null
  returning (select e.inquiry_id from public.enrollments e where e.id = onboardings.enrollment_id) into v_inquiry;
  if v_inquiry is null then
    select p.full_name into v_owner from public.onboardings o join public.profiles p on p.id = o.support_owner_id where o.id = p_onboarding;
    if v_owner is not null then perform private.fail('Already assigned to ' || v_owner || '.'); end if;
    raise exception using errcode = 'CRM04', message = 'This customer is not in the support queue.';
  end if;
  perform private.log_activity(v_inquiry, 'support_assignment', 'Assigned to support: ' || (select full_name from public.profiles where id = auth.uid()),
    jsonb_build_object('to', auth.uid()));
end $$;

create or replace function public.assign_onboarding(p_onboarding uuid, p_to uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  o public.onboardings;
  v_name text;
  v_inquiry uuid;
begin
  perform private.require_role('manager');
  select full_name into v_name from public.profiles where id = p_to and role = 'support' and active;
  if v_name is null then perform private.fail('Choose an active support team member.'); end if;
  select * into o from public.onboardings where id = p_onboarding for update;
  if not found then raise exception using errcode = 'CRM04', message = 'Onboarding not found.'; end if;
  if o.support_owner_id = p_to then return; end if;
  if o.support_owner_id is not null and coalesce(trim(p_reason), '') = '' then perform private.fail('Add a reason for the reassignment.'); end if;
  select inquiry_id into v_inquiry from public.enrollments where id = o.enrollment_id;
  update public.onboardings set support_owner_id = p_to, claimed_at = coalesce(claimed_at, now()),
    status = case when status = 'new_customer' then 'onboarding'::public.support_status else status end, version = version + 1
  where id = o.id;
  update public.support_follow_ups set owner_id = p_to where onboarding_id = o.id and status = 'open';
  perform private.log_activity(v_inquiry, 'support_assignment',
    'Support owner: ' || v_name || coalesce(' (' || nullif(trim(p_reason), '') || ')', ''), jsonb_build_object('from', o.support_owner_id, 'to', p_to));
  perform private.notify(p_to, 'Customer assigned to you for onboarding: ' || private.contact_name(v_inquiry), v_inquiry);
  if o.support_owner_id is not null then
    perform private.audit('Reassigned support owner to ' || v_name, private.contact_name(v_inquiry));
  end if;
end $$;

create or replace function public.set_checklist_item(p_onboarding uuid, p_item uuid, p_done boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  it public.onboarding_items;
  v_inquiry uuid;
begin
  perform private.require_role('manager', 'support');
  if not private.can_work_onboarding(p_onboarding) then
    raise exception using errcode = 'CRM03', message = 'Only the support owner can update this checklist.';
  end if;
  select * into it from public.onboarding_items where onboarding_id = p_onboarding and template_item_id = p_item for update;
  if not found then raise exception using errcode = 'CRM04', message = 'Checklist item not found.'; end if;
  if (it.done_at is not null) = p_done then return; end if;
  update public.onboarding_items set done_at = case when p_done then now() end, done_by = case when p_done then auth.uid() end
  where onboarding_id = p_onboarding and template_item_id = p_item;
  select e.inquiry_id into v_inquiry from public.onboardings o join public.enrollments e on e.id = o.enrollment_id where o.id = p_onboarding;
  perform private.log_activity(v_inquiry, 'checklist', case when p_done then 'Done: ' else 'Reopened: ' end || it.label);
end $$;

create or replace function public.set_onboarding_status(p_onboarding uuid, p_status public.support_status)
returns void language plpgsql security definer set search_path = '' as $$
declare
  o public.onboardings;
  v_open text[];
  v_inquiry uuid;
begin
  perform private.require_role('manager', 'support');
  if not private.can_work_onboarding(p_onboarding) then
    raise exception using errcode = 'CRM03', message = 'Only the support owner can change the status.';
  end if;
  select * into o from public.onboardings where id = p_onboarding for update;
  if o.status = p_status then return; end if;
  if p_status = 'active' then
    select coalesce(array_agg(label order by sort), '{}') into v_open from public.onboarding_items where onboarding_id = o.id and done_at is null;
    if cardinality(v_open) > 0 then
      perform private.fail('Finish the onboarding checklist first.', to_jsonb(v_open)::text);
    end if;
    if o.flagged_reason is not null then perform private.fail('This customer is flagged for review. A manager must resolve it first.'); end if;
  end if;
  update public.onboardings set status = p_status, activated_at = case when p_status = 'active' then now() else activated_at end, version = version + 1
  where id = o.id;
  select inquiry_id into v_inquiry from public.enrollments where id = o.enrollment_id;
  perform private.log_activity(v_inquiry, 'support_status', 'Support status: ' || replace(initcap(replace(p_status::text, '_', ' ')), 'Customer', 'customer'));
end $$;

-- Manager clears a review flag after checking (for example the customer paid again outside the CRM).
create or replace function public.clear_onboarding_flag(p_onboarding uuid, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_inquiry uuid;
begin
  perform private.require_role('manager');
  if coalesce(trim(p_note), '') = '' then perform private.fail('Add a note explaining how it was resolved.'); end if;
  update public.onboardings set flagged_reason = null, version = version + 1 where id = p_onboarding and flagged_reason is not null
  returning (select inquiry_id from public.enrollments e where e.id = onboardings.enrollment_id) into v_inquiry;
  if v_inquiry is null then perform private.fail('This customer is not flagged.'); end if;
  perform private.log_activity(v_inquiry, 'comment', 'Review flag cleared: ' || trim(p_note));
  perform private.audit('Cleared onboarding flag (' || trim(p_note) || ')', private.contact_name(v_inquiry));
end $$;

create or replace function public.create_support_follow_up(p_onboarding uuid, p_due timestamptz, p_note text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_owner uuid;
  v_inquiry uuid;
begin
  perform private.require_role('manager', 'support');
  if not private.can_work_onboarding(p_onboarding) then
    raise exception using errcode = 'CRM03', message = 'Only the support owner can add follow-ups.';
  end if;
  if p_due is null then perform private.fail('Choose a date and time.'); end if;
  if coalesce(trim(p_note), '') = '' then perform private.fail('Describe what to do.'); end if;
  if p_due < now() - interval '1 day' then perform private.fail('The follow-up date is in the past.'); end if;
  select o.support_owner_id, e.inquiry_id into v_owner, v_inquiry from public.onboardings o join public.enrollments e on e.id = o.enrollment_id where o.id = p_onboarding;
  insert into public.support_follow_ups (onboarding_id, owner_id, due_at, note, created_by)
  values (p_onboarding, coalesce(v_owner, auth.uid()), p_due, trim(p_note), auth.uid()) returning id into v_id;
  perform private.log_activity(v_inquiry, 'support_follow_up', 'Support follow-up: ' || trim(p_note), jsonb_build_object('due_at', p_due));
  return v_id;
end $$;

create or replace function public.complete_support_follow_up(p_follow_up uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  f public.support_follow_ups;
  v_inquiry uuid;
begin
  perform private.require_role('manager', 'support');
  select * into f from public.support_follow_ups where id = p_follow_up for update;
  if not found or not private.can_work_onboarding(f.onboarding_id) then
    raise exception using errcode = 'CRM04', message = 'This follow-up does not exist or is not yours.';
  end if;
  if f.status <> 'open' then perform private.fail('This follow-up is already closed.'); end if;
  update public.support_follow_ups set status = 'done', completed_at = now(), completed_by = auth.uid() where id = f.id;
  select e.inquiry_id into v_inquiry from public.onboardings o join public.enrollments e on e.id = o.enrollment_id where o.id = f.onboarding_id;
  perform private.log_activity(v_inquiry, 'follow_up_completed', f.note);
end $$;

-- Notes from support appear on the same customer timeline (sales history stays read-only for them).
create or replace function public.add_support_note(p_onboarding uuid, p_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_inquiry uuid;
begin
  perform private.require_role('manager', 'support');
  if not private.can_work_onboarding(p_onboarding) then
    raise exception using errcode = 'CRM03', message = 'Only the support owner can add notes here.';
  end if;
  if coalesce(trim(p_body), '') = '' then perform private.fail('Write a note first.'); end if;
  if length(p_body) > 4000 then perform private.fail('Notes can be 4,000 characters at most.'); end if;
  select e.inquiry_id into v_inquiry from public.onboardings o join public.enrollments e on e.id = o.enrollment_id where o.id = p_onboarding;
  return private.log_activity(v_inquiry, 'comment', p_body);
end $$;

-- ── Checklist template (manager) ─────────────────────────────────────────

-- p: id?, label, due_after_days
create or replace function public.save_checklist_item(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  perform private.require_role('manager');
  if coalesce(trim(p ->> 'label'), '') = '' then perform private.fail('Describe the checklist step.'); end if;
  if v_id is null then
    insert into public.checklist_template (label, due_after_days, sort)
    values (trim(p ->> 'label'), nullif(p ->> 'due_after_days', '')::integer, coalesce((select max(sort) + 1 from public.checklist_template), 1))
    returning id into v_id;
  else
    update public.checklist_template set label = trim(p ->> 'label'), due_after_days = nullif(p ->> 'due_after_days', '')::integer where id = v_id;
    if not found then raise exception using errcode = 'CRM04', message = 'Checklist step not found.'; end if;
  end if;
  perform private.audit('Saved onboarding checklist step', trim(p ->> 'label'));
  return v_id;
end $$;

create or replace function public.set_checklist_item_archived(p_id uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_label text;
begin
  perform private.require_role('manager');
  update public.checklist_template set archived = p_archived where id = p_id returning label into v_label;
  if v_label is null then raise exception using errcode = 'CRM04', message = 'Checklist step not found.'; end if;
  perform private.audit(case when p_archived then 'Archived checklist step' else 'Restored checklist step' end, v_label);
end $$;

create or replace function public.move_checklist_item(p_id uuid, p_dir integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  a public.checklist_template;
  b public.checklist_template;
begin
  perform private.require_role('manager');
  select * into a from public.checklist_template where id = p_id;
  if not found then raise exception using errcode = 'CRM04', message = 'Checklist step not found.'; end if;
  select * into b from public.checklist_template
  where not archived and case when p_dir < 0 then sort < a.sort else sort > a.sort end
  order by case when p_dir < 0 then -sort else sort end limit 1;
  if not found then return; end if;
  update public.checklist_template set sort = b.sort where id = a.id;
  update public.checklist_template set sort = a.sort where id = b.id;
end $$;

grant execute on function public.save_enrollment(jsonb), public.submit_payment(jsonb), public.decide_payment(uuid, text, text),
  public.reverse_payment(uuid, text), public.claim_onboarding(uuid), public.assign_onboarding(uuid, uuid, text),
  public.set_checklist_item(uuid, uuid, boolean), public.set_onboarding_status(uuid, public.support_status),
  public.clear_onboarding_flag(uuid, text), public.create_support_follow_up(uuid, timestamptz, text),
  public.complete_support_follow_up(uuid), public.add_support_note(uuid, text), public.save_checklist_item(jsonb),
  public.set_checklist_item_archived(uuid, boolean), public.move_checklist_item(uuid, integer) to authenticated;
revoke execute on function public.save_enrollment(jsonb), public.submit_payment(jsonb), public.decide_payment(uuid, text, text),
  public.reverse_payment(uuid, text), public.claim_onboarding(uuid), public.assign_onboarding(uuid, uuid, text),
  public.set_checklist_item(uuid, uuid, boolean), public.set_onboarding_status(uuid, public.support_status),
  public.clear_onboarding_flag(uuid, text), public.create_support_follow_up(uuid, timestamptz, text),
  public.complete_support_follow_up(uuid), public.add_support_note(uuid, text), public.save_checklist_item(jsonb),
  public.set_checklist_item_archived(uuid, boolean), public.move_checklist_item(uuid, integer) from public, anon;

-- ── Reference data ───────────────────────────────────────────────────────
-- Starter onboarding checklist (editable in Settings → Support Checklist).
insert into public.checklist_template (label, sort, due_after_days) values
  ('Welcome call done', 1, 1),
  ('Added to the class WhatsApp group', 2, 1),
  ('Learning platform account created', 3, 2),
  ('Class schedule shared', 4, 2),
  ('Diagnostic test booked', 5, 7);

-- ── Receipt storage (Supabase only) ──────────────────────────────────────
-- A private bucket: files are reached only by the server with the secret key, after the CRM has
-- checked that the signed-in person may see the payment. Skipped on the local review database.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('receipts', 'receipts', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
    on conflict (id) do nothing;
  end if;
end $$;
