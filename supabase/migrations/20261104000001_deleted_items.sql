-- CRM changes plan 3, release 2 (28 Oct 2026): Delete payments, enrollments, leads and customers,
-- with Settings → Deleted items and 30 days to restore.
--
-- How it works: a delete copies every affected row into public.deleted_records (one JSON snapshot
-- per delete, table by table), then removes the live rows, so the record leaves every list, report
-- and Accounting figure at once. Restore puts the same rows back with the same ids and history.
-- Snapshots older than 30 days are removed for good by the hourly housekeeping (and whenever the
-- Deleted items list is opened).
--
-- Rules (enforced here, not only on screen):
--   managers delete and restore anything; the accountant deletes payments and restores the
--   payments they deleted; support and sales cannot delete.
--   Every delete needs a reason; confirmed money also needs the word DELETE.
--   Records with sessions in a closed salary month cannot be deleted until the month is reopened.
--   A deleted Google Sheets lead keeps its row in the import ledger, so it is not imported again.
--   Deleting a payment flags the customer if recorded payments drop below the handover rule.
-- Only adds a table and functions; no existing record changes until someone deletes it.

create table public.deleted_records (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('payment', 'enrollment', 'lead', 'customer')),
  record_id uuid not null,              -- the payment, enrollment, lead (inquiry) or person (contact)
  inquiry_id uuid,                      -- the lead it belonged to (for payments and enrollments)
  enrollment_id uuid,                   -- the enrollment it belonged to (for payments)
  label text not null,                  -- what it was, e.g. "Sara Nasser · IELTS Academic"
  summary text not null,                -- what went with it, e.g. "1 lead, 2 enrollments, 3 payments"
  reason text not null,
  data jsonb not null,                  -- {"<table>": [rows…]} exactly as they were
  deleted_by uuid not null references public.profiles (id),
  deleted_at timestamptz not null default now(),
  purge_after timestamptz not null default now() + interval '30 days'
);
-- "Payment deleted" and "Enrollment restored" lines on the lead's timeline.
alter table public.activities drop constraint activities_type_check;
alter table public.activities add constraint activities_type_check check (type in (
  'comment', 'contact_attempt', 'stage_change', 'owner_change', 'follow_up_created', 'follow_up_completed',
  'payment_submitted', 'payment_decision', 'handover', 'checklist', 'support_status', 'tag_change',
  'do_not_contact', 'imported', 'resubmitted', 'outreach_shortcut', 'field_change', 'reservation',
  'enrollment', 'support_assignment', 'support_follow_up', 'payment_plan', 'teacher', 'session', 'deleted'
));

create index deleted_records_purge on public.deleted_records (purge_after);
alter table public.deleted_records enable row level security;
revoke all on public.deleted_records from anon, authenticated;
-- No direct access: the list, restore and delete functions below check the role.

-- Tables in the order they are put back (deletes go in reverse).
create or replace function private.deleted_tables()
returns text[] language sql immutable set search_path = '' as $$
  select array['contacts', 'inquiries', 'inquiry_tags', 'activities', 'follow_ups', 'field_values',
               'enrollments', 'onboardings', 'onboarding_items', 'support_follow_ups',
               'payments', 'payment_dues', 'teacher_assignments', 'teacher_sessions']
$$;

-- Everything that goes with a set of contacts, leads, enrollments and payments, as one snapshot.
-- p_contacts: people deleted with all their leads; p_inquiries: leads deleted with everything under
-- them; p_enrollments: enrollments deleted with their payments, plan, onboarding, teachers and
-- sessions; p_payments: single payments.
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

-- What a snapshot holds, in words and numbers (for the dialog, the list and the audit line).
create or replace function private.describe_deleted(d jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  n_people int := jsonb_array_length(d -> 'contacts');
  n_leads int := jsonb_array_length(d -> 'inquiries');
  n_enr int := jsonb_array_length(d -> 'enrollments');
  n_pay int := jsonb_array_length(d -> 'payments');
  n_sess int := jsonb_array_length(d -> 'teacher_sessions');
  v_money jsonb;
  v_money_text text;
  v_closed text;
  parts text[] := '{}';
begin
  -- Confirmed money, per currency. A payment's currency is its enrollment's: from the snapshot,
  -- or the live enrollment when only the payment is deleted.
  select coalesce(jsonb_object_agg(cur, total), '{}'), string_agg(private.money(total, cur), ' + ' order by cur)
    into v_money, v_money_text
    from (select coalesce(se.currency, le.currency) as cur, sum((p ->> 'amount')::numeric) as total
            from jsonb_array_elements(d -> 'payments') p
            left join lateral (select e ->> 'currency' as currency from jsonb_array_elements(d -> 'enrollments') e where e ->> 'id' = p ->> 'enrollment_id') se on true
            left join public.enrollments le on le.id = (p ->> 'enrollment_id')::uuid
           where p ->> 'status' = 'confirmed'
           group by 1) m;
  -- The first closed salary month among the sessions, if any.
  select to_char(min(private.salary_month_of(((s ->> 'starts_at')::timestamptz at time zone 'Africa/Cairo')::date)), 'FMMonth YYYY')
    into v_closed
    from jsonb_array_elements(d -> 'teacher_sessions') s
   where private.salary_closed(private.salary_month_of(((s ->> 'starts_at')::timestamptz at time zone 'Africa/Cairo')::date));
  if n_people > 0 then parts := parts || format('%s person%s', n_people, case when n_people = 1 then '' else 's' end); end if;
  if n_leads > 0 then parts := parts || format('%s lead%s', n_leads, case when n_leads = 1 then '' else 's' end); end if;
  if n_enr > 0 then parts := parts || format('%s enrollment%s', n_enr, case when n_enr = 1 then '' else 's' end); end if;
  if n_pay > 0 then parts := parts || (format('%s payment%s', n_pay, case when n_pay = 1 then '' else 's' end)
                                        || case when v_money_text is null then '' else format(' (%s confirmed)', v_money_text) end); end if;
  if n_sess > 0 then parts := parts || format('%s session%s', n_sess, case when n_sess = 1 then '' else 's' end); end if;
  return jsonb_build_object('summary', array_to_string(parts, ', '), 'people', n_people, 'leads', n_leads, 'enrollments', n_enr,
    'payments', n_pay, 'sessions', n_sess, 'confirmed', v_money, 'needsTyped', v_money <> '{}'::jsonb, 'closedMonth', v_closed);
end $$;

-- Finds the record and what would go with it. Returns the snapshot and its description.
create or replace function private.deletion_plan(p_kind text, p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_inquiry uuid;
  v_enrollment uuid;
  v_contact uuid;
  v_label text;
  v_amount text;
  v_alone boolean;
  d jsonb;
begin
  if p_kind = 'payment' then
    select p.enrollment_id, e.inquiry_id,
           format('%s · %s · %s', private.contact_name(e.inquiry_id), co.name, private.money(p.amount, e.currency)),
           private.money(p.amount, e.currency)
      into v_enrollment, v_inquiry, v_label, v_amount
      from public.payments p join public.enrollments e on e.id = p.enrollment_id join public.courses co on co.id = e.course_id
     where p.id = p_id;
    if not found then raise exception using errcode = 'CRM04', message = 'Payment not found.'; end if;
    d := private.collect_deleted('{}', '{}', '{}', array[p_id]);
  elsif p_kind = 'enrollment' then
    select e.inquiry_id, format('%s · %s', private.contact_name(e.inquiry_id), co.name)
      into v_inquiry, v_label
      from public.enrollments e join public.courses co on co.id = e.course_id where e.id = p_id;
    if not found then raise exception using errcode = 'CRM04', message = 'Enrollment not found.'; end if;
    d := private.collect_deleted('{}', '{}', array[p_id], '{}');
  elsif p_kind = 'lead' then
    select i.contact_id, format('%s · %s', c.name, coalesce(pr.code, pr.name)),
           not exists (select 1 from public.inquiries o where o.contact_id = i.contact_id and o.id <> i.id)
      into v_contact, v_label, v_alone
      from public.inquiries i join public.contacts c on c.id = i.contact_id left join public.programs pr on pr.id = i.program_id
     where i.id = p_id;
    if not found then raise exception using errcode = 'CRM04', message = 'Lead not found.'; end if;
    v_inquiry := p_id;
    -- The person's only lead: the person goes too, so no empty record is left behind.
    d := private.collect_deleted(case when v_alone then array[v_contact] else '{}' end, array[p_id], '{}', '{}');
  elsif p_kind = 'customer' then
    select c.name into v_label from public.contacts c where c.id = p_id;
    if not found then raise exception using errcode = 'CRM04', message = 'Customer not found.'; end if;
    d := private.collect_deleted(array[p_id], '{}', '{}', '{}');
  else
    perform private.fail('Choose what to delete.');
  end if;
  return jsonb_build_object('label', v_label, 'inquiryId', v_inquiry, 'enrollmentId', v_enrollment, 'amount', v_amount, 'data', d) || private.describe_deleted(d);
end $$;

create or replace function private.require_delete_role(p_kind text)
returns public.app_role language plpgsql stable security definer set search_path = '' as $$
begin
  if p_kind = 'payment' then return private.require_role('manager', 'accountant'); end if;
  return private.require_role('manager');
end $$;

-- What a delete would remove, for the dialog. Nothing changes.
create or replace function public.delete_preview(p_kind text, p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform private.require_delete_role(p_kind);
  v := private.deletion_plan(p_kind, p_id);
  return v - 'data';
end $$;

-- Delete. p: {kind, id, reason, confirm}. confirm must be "DELETE" when confirmed money goes.
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
  end if;
  v := private.deletion_plan(v_kind, v_id);
  d := v -> 'data';
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
  delete from public.payments where enrollment_id = any (v_enr) or id in (select (x ->> 'id')::uuid from jsonb_array_elements(d -> 'payments') x);
  delete from public.onboardings where enrollment_id = any (v_enr);   -- its checklist and follow-ups go with it
  delete from public.enrollments where id = any (v_enr);
  delete from public.inquiries where id = any (v_inq);                -- tags, timeline, follow-ups, fields and notifications go with it
  delete from public.contacts where id in (select (x ->> 'id')::uuid from jsonb_array_elements(d -> 'contacts') x);

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

-- Snapshots past their 30 days are removed for good. Returns how many.
create or replace function private.purge_deleted(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.deleted_records where purge_after <= p_now;
  get diagnostics n = row_count;
  return n;
end $$;

-- Settings → Deleted items. Managers see everything; the accountant sees the payments they deleted.
create or replace function public.deleted_items()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_role public.app_role;
begin
  v_role := private.require_role('manager', 'accountant');
  perform private.purge_deleted(now());
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'kind', r.kind, 'label', r.label, 'summary', r.summary, 'reason', r.reason,
             'deletedBy', pr.full_name, 'deletedById', r.deleted_by, 'deletedAt', r.deleted_at, 'purgeAfter', r.purge_after,
             'confirmed', private.describe_deleted(r.data) -> 'confirmed')
           order by r.deleted_at desc)
      from public.deleted_records r join public.profiles pr on pr.id = r.deleted_by
     where v_role = 'manager' or (r.kind = 'payment' and r.deleted_by = auth.uid())), '[]'::jsonb);
end $$;

-- Puts a deleted record back, with the same ids and history.
create or replace function public.restore_deleted(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_role public.app_role;
  r public.deleted_records;
  d jsonb;
  t text;
  v_cols text;
  v_inq uuid[];
  v_queued int := 0;
  v_sess jsonb;
begin
  v_role := private.require_role('manager', 'accountant');
  select * into r from public.deleted_records where id = p_id for update;
  if not found then raise exception using errcode = 'CRM04', message = 'This deleted item is no longer available.'; end if;
  if v_role <> 'manager' and not (r.kind = 'payment' and r.deleted_by = auth.uid()) then
    raise exception using errcode = 'CRM03', message = 'You do not have permission to do this.';
  end if;
  d := r.data;
  -- What it belonged to must still be there.
  if r.kind = 'payment' and not exists (select 1 from public.enrollments where id = r.enrollment_id) then
    perform private.fail('The enrollment this payment belonged to was deleted too. Restore the enrollment (or its lead) first.');
  end if;
  if r.kind = 'enrollment' and not exists (select 1 from public.inquiries where id = r.inquiry_id) then
    perform private.fail('The lead this enrollment belonged to was deleted too. Restore the lead (or the person) first.');
  end if;
  if r.kind = 'lead' and jsonb_array_length(d -> 'contacts') = 0
     and not exists (select 1 from public.contacts where id = (d -> 'inquiries' -> 0 ->> 'contact_id')::uuid) then
    perform private.fail('The person this lead belonged to was deleted too. Restore the person first.');
  end if;
  -- Sessions go back only into open salary months.
  select s into v_sess from jsonb_array_elements(d -> 'teacher_sessions') s
   where private.salary_closed(private.salary_month_of(((s ->> 'starts_at')::timestamptz at time zone 'Africa/Cairo')::date)) limit 1;
  if v_sess is not null then
    perform private.fail(format('Salaries for %s are now closed, and this has sessions in that month. A manager can reopen the month in Accounting → Teachers, then restore it.',
      to_char(private.salary_month_of(((v_sess ->> 'starts_at')::timestamptz at time zone 'Africa/Cairo')::date), 'FMMonth YYYY')));
  end if;

  begin
    foreach t in array private.deleted_tables() loop
      if jsonb_array_length(coalesce(d -> t, '[]')) = 0 then continue; end if;
      -- Only the columns the snapshot has; a column added since takes its default.
      select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position) into v_cols
        from information_schema.columns c
       where c.table_schema = 'public' and c.table_name = t and (d -> t -> 0) ? c.column_name and c.is_generated = 'NEVER';
      execute format('insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1)', t, v_cols, v_cols, t) using d -> t;
    end loop;
  exception
    when unique_violation then
      perform private.fail('This cannot be restored because a matching record was added after the delete (for example the same phone number). Delete or merge that record first.');
    when foreign_key_violation then
      perform private.fail('Something this record points to was deleted since (for example a teacher, a rate or a course). Restore that first.');
  end;

  v_inq := array(select (x ->> 'id')::uuid from jsonb_array_elements(d -> 'inquiries') x);
  if array_length(v_inq, 1) > 0 then
    -- Inserting a lead runs the new-lead triggers; undo their side effects so it comes back as it was.
    delete from public.notifications where inquiry_id = any (v_inq) and kind = 'new_lead' and created_at = now();
    update public.inquiries i set owner_opened_at = (x ->> 'owner_opened_at')::timestamptz, unopened_alert_at = (x ->> 'unopened_alert_at')::timestamptz
      from jsonb_array_elements(d -> 'inquiries') x where i.id = (x ->> 'id')::uuid;
    -- A sales agent who has left: the lead goes back to the queue.
    with gone as (
      update public.inquiries i set sales_owner_id = null, version = version + 1
       where i.id = any (v_inq) and i.sales_owner_id is not null
         and not exists (select 1 from public.profiles pr where pr.id = i.sales_owner_id and pr.active)
      returning i.id)
    select count(*) into v_queued from gone;
    insert into public.activities (inquiry_id, type, actor_id, body)
    select i.id, 'owner_change', null, 'Sales agent has left; waiting in the unassigned queue'
      from public.inquiries i where i.id = any (v_inq) and i.sales_owner_id is null and v_queued > 0;
    -- Relink the Google Sheets ledger and Needs Review items.
    update public.sheet_rows s set inquiry_id = (x ->> 'inquiry_id')::uuid
      from jsonb_array_elements(d -> 'sheet_rows') x
     where s.connection_id = (x ->> 'connection_id')::uuid and s.row_key = x ->> 'row_key' and s.inquiry_id is null;
    update public.review_items ri set inquiry_id = (x ->> 'inquiry_id')::uuid
      from jsonb_array_elements(d -> 'review_items') x where ri.id = (x ->> 'id')::uuid and ri.inquiry_id is null;
  end if;

  if r.kind in ('payment', 'enrollment') then
    perform private.log_activity(r.inquiry_id, 'deleted', format('%s restored: %s', initcap(r.kind), r.label),
      jsonb_build_object('kind', r.kind, 'restored', true));
  end if;
  perform private.audit(format('Restored %s', r.kind), r.label,
    jsonb_build_object('kind', r.kind, 'record_id', r.record_id, 'summary', r.summary, 'deleted_by', r.deleted_by, 'deleted_at', r.deleted_at));
  delete from public.deleted_records where id = r.id;
  return jsonb_build_object('kind', r.kind, 'recordId', r.record_id, 'inquiryId', coalesce(r.inquiry_id, (d -> 'inquiries' -> 0 ->> 'id')::uuid), 'queued', v_queued);
end $$;

-- Receipts of deleted payments stay on file until the snapshot is purged (see storage.ts).
create or replace function private.deleted_receipts()
returns setof text language sql stable security definer set search_path = '' as $$
  select p ->> 'receipt_path' from public.deleted_records r, jsonb_array_elements(r.data -> 'payments') p where p ->> 'receipt_path' is not null
$$;

revoke all on function private.deleted_tables(), private.collect_deleted(uuid[], uuid[], uuid[], uuid[]), private.describe_deleted(jsonb),
  private.deletion_plan(text, uuid), private.require_delete_role(text), private.purge_deleted(timestamptz), private.deleted_receipts() from public, anon, authenticated;
revoke all on function public.delete_preview(text, uuid), public.delete_record(jsonb), public.deleted_items(), public.restore_deleted(uuid) from public, anon;
grant execute on function public.delete_preview(text, uuid), public.delete_record(jsonb), public.deleted_items(), public.restore_deleted(uuid) to authenticated;
