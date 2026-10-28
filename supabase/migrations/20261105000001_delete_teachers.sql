-- CRM changes plan 3, release 3 (28 Oct 2026): delete teachers and rates (managers).
-- A teacher or rate never used (no customers, group courses, sessions, salary lines or salary
-- bonuses/deductions) is deleted straight away and can be restored from Deleted items for 30 days.
-- One already used cannot be deleted: the dialog says what is linked and offers Not active (teacher)
-- or Archive (rate), which keep the history. Same Deleted items, audit and purge as release 2.
-- Only replaces functions; no teacher or rate changes until a manager deletes one.

alter table public.deleted_records drop constraint deleted_records_kind_check;
alter table public.deleted_records add constraint deleted_records_kind_check
  check (kind in ('payment', 'enrollment', 'lead', 'customer', 'teacher', 'rate'));

create or replace function private.deleted_tables()
returns text[] language sql immutable set search_path = '' as $$
  select array['teachers', 'teacher_rates', 'teacher_rate_amounts',
               'contacts', 'inquiries', 'inquiry_tags', 'activities', 'follow_ups', 'field_values',
               'enrollments', 'onboardings', 'onboarding_items', 'support_follow_ups',
               'payments', 'payment_dues', 'teacher_assignments', 'teacher_sessions']
$$;

-- What links a teacher (or one rate) to customers, group courses, sessions and salaries.
-- Used: anything at all, so deleting would erase history; the summary says what.
create or replace function private.teacher_links(p_teacher uuid, p_rate uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  n_customers int; n_groups int; n_scheduled int; n_recorded int; n_months int; n_closed int; n_adjust int; n_deleted int;
  parts text[] := '{}';
begin
  select count(*) filter (where enrollment_id is not null), count(*) filter (where course_id is not null and enrollment_id is null)
    into n_customers, n_groups
    from public.teacher_assignments where (p_teacher is not null and teacher_id = p_teacher) or (p_rate is not null and rate_id = p_rate);
  select count(*) filter (where status = 'scheduled'), count(*) filter (where status <> 'scheduled')
    into n_scheduled, n_recorded
    from public.teacher_sessions where (p_teacher is not null and teacher_id = p_teacher) or (p_rate is not null and rate_id = p_rate);
  select count(distinct l.month), count(distinct l.month) filter (where m.status = 'closed')
    into n_months, n_closed
    from public.salary_lines l left join public.salary_months m on m.month = l.month
   where (p_teacher is not null and l.teacher_id = p_teacher) or (p_rate is not null and l.rate_id = p_rate);
  select count(*) into n_adjust from public.salary_adjustments where p_teacher is not null and teacher_id = p_teacher;
  -- Deleted enrollments that can still be restored would lose their teacher.
  select count(*) into n_deleted from public.deleted_records r
   where exists (select 1 from jsonb_array_elements(coalesce(r.data -> 'teacher_assignments', '[]') || coalesce(r.data -> 'teacher_sessions', '[]')) x
                  where (p_teacher is not null and x ->> 'teacher_id' = p_teacher::text) or (p_rate is not null and x ->> 'rate_id' = p_rate::text));
  if n_customers > 0 then parts := parts || format('%s customer%s', n_customers, case when n_customers = 1 then '' else 's' end); end if;
  if n_groups > 0 then parts := parts || format('%s group course%s', n_groups, case when n_groups = 1 then '' else 's' end); end if;
  if n_recorded > 0 then parts := parts || format('%s recorded session%s', n_recorded, case when n_recorded = 1 then '' else 's' end); end if;
  if n_scheduled > 0 then parts := parts || format('%s scheduled session%s', n_scheduled, case when n_scheduled = 1 then '' else 's' end); end if;
  if n_closed > 0 then parts := parts || format('%s closed salary month%s', n_closed, case when n_closed = 1 then '' else 's' end);
  elsif n_months > 0 then parts := parts || format('%s salary month%s', n_months, case when n_months = 1 then '' else 's' end); end if;
  if n_adjust > 0 then parts := parts || format('%s salary bonus or deduction%s', n_adjust, case when n_adjust = 1 then '' else 's' end); end if;
  if n_deleted > 0 then parts := parts || format('%s deleted item%s that can still be restored', n_deleted, case when n_deleted = 1 then '' else 's' end); end if;
  return jsonb_build_object('used', cardinality(parts) > 0, 'summary', nullif(array_to_string(parts, ', '), ''));
end $$;

create or replace function private.deletion_plan(p_kind text, p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_inquiry uuid;
  v_enrollment uuid;
  v_contact uuid;
  v_label text;
  v_amount text;
  v_alone boolean;
  v_teacher uuid;
  v_links jsonb;
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
  elsif p_kind in ('teacher', 'rate') then
    if p_kind = 'teacher' then
      select t.full_name into v_label from public.teachers t where t.id = p_id;
      if not found then raise exception using errcode = 'CRM04', message = 'Teacher not found.'; end if;
      v_teacher := p_id;
    else
      select r.teacher_id, format('%s · %s', t.full_name, r.name) into v_teacher, v_label
        from public.teacher_rates r join public.teachers t on t.id = r.teacher_id where r.id = p_id;
      if not found then raise exception using errcode = 'CRM04', message = 'Rate not found.'; end if;
    end if;
    v_links := private.teacher_links(case when p_kind = 'teacher' then p_id end, case when p_kind = 'rate' then p_id end);
    d := jsonb_build_object(
      'teachers',             (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.teachers x where p_kind = 'teacher' and id = p_id),
      'teacher_rates',        (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.teacher_rates x where (p_kind = 'teacher' and teacher_id = p_id) or (p_kind = 'rate' and id = p_id)),
      'teacher_rate_amounts', (select coalesce(jsonb_agg(to_jsonb(a)), '[]') from public.teacher_rate_amounts a join public.teacher_rates x on x.id = a.rate_id
                                where (p_kind = 'teacher' and x.teacher_id = p_id) or (p_kind = 'rate' and x.id = p_id)));
    return jsonb_build_object('label', v_label, 'teacherId', v_teacher, 'data', d,
      'summary', case when p_kind = 'teacher'
                      then format('1 teacher, %s rate%s', jsonb_array_length(d -> 'teacher_rates'), case when jsonb_array_length(d -> 'teacher_rates') = 1 then '' else 's' end)
                      else '1 rate' end,
      'people', 0, 'leads', 0, 'enrollments', 0, 'payments', 0, 'sessions', 0, 'confirmed', '{}'::jsonb, 'needsTyped', false, 'closedMonth', null,
      'used', (v_links ->> 'used')::boolean, 'linked', v_links ->> 'summary');
  else
    perform private.fail('Choose what to delete.');
  end if;
  return jsonb_build_object('label', v_label, 'inquiryId', v_inquiry, 'enrollmentId', v_enrollment, 'amount', v_amount, 'data', d) || private.describe_deleted(d) || jsonb_build_object('used', false, 'linked', null);
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
  if r.kind = 'rate' and not exists (select 1 from public.teachers where id = (d -> 'teacher_rates' -> 0 ->> 'teacher_id')::uuid) then
    perform private.fail('The teacher this rate belonged to was deleted too. Restore the teacher first.');
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

revoke all on function private.teacher_links(uuid, uuid) from public, anon, authenticated;
