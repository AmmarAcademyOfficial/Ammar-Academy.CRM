-- Ammar Academy CRM · Phase 2 · business functions
--
-- Every change in the CRM goes through one of these functions. Each runs as
-- SECURITY DEFINER with an empty search_path, checks who is calling, and runs
-- in one transaction, so a failed rule leaves nothing half-written.
--
-- Error codes (SQLSTATE), mapped to messages in the app:
--   CRM01  business rule (message is safe to show the user; DETAIL may hold a JSON list)
--   CRM03  permission
--   CRM04  not found or not visible
--   CRM09  someone else saved this record first (stale version)

-- ── Internal helpers ─────────────────────────────────────────────────────

create or replace function private.require_role(variadic p_roles public.app_role[])
returns public.app_role language plpgsql stable security definer set search_path = '' as $$
declare v public.app_role := private.my_role();
begin
  if v is null then
    raise exception using errcode = 'CRM03', message = 'Your account is not active. Sign in again or ask a manager.';
  end if;
  if not (v = any (p_roles)) then
    raise exception using errcode = 'CRM03', message = 'You do not have permission to do this.';
  end if;
  return v;
end $$;

create or replace function private.fail(p_message text, p_detail text default null)
returns void language plpgsql as $$
begin
  raise exception using errcode = 'CRM01', message = p_message, detail = coalesce(p_detail, '');
end $$;

-- Locks and returns an inquiry the caller may work on.
create or replace function private.inquiry_for_work(p_inquiry uuid)
returns public.inquiries language plpgsql security definer set search_path = '' as $$
declare q public.inquiries;
begin
  perform private.require_role('manager', 'sales');
  select * into q from public.inquiries where id = p_inquiry for update;
  if not found or not private.can_work_inquiry(p_inquiry) then
    raise exception using errcode = 'CRM04', message = 'This record does not exist or is not assigned to you.';
  end if;
  return q;
end $$;

create or replace function private.check_version(q public.inquiries, p_expected integer)
returns void language plpgsql as $$
begin
  if p_expected is not null and q.version <> p_expected then
    raise exception using errcode = 'CRM09', message = 'Someone else saved this record while you were editing.';
  end if;
end $$;

create or replace function private.log_activity(p_inquiry uuid, p_type text, p_body text default null, p_meta jsonb default '{}'::jsonb, p_actor uuid default null)
returns uuid language sql security definer set search_path = '' as $$
  insert into public.activities (inquiry_id, type, actor_id, body, meta)
  values (p_inquiry, p_type, coalesce(p_actor, auth.uid()), nullif(trim(p_body), ''), coalesce(p_meta, '{}'::jsonb))
  returning id
$$;

create or replace function private.notify(p_user uuid, p_text text, p_inquiry uuid default null)
returns void language sql security definer set search_path = '' as $$
  insert into public.notifications (user_id, text, inquiry_id) values (p_user, p_text, p_inquiry)
$$;

create or replace function private.audit(p_action text, p_target text, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_log (actor_id, action, target, details) values (auth.uid(), p_action, p_target, coalesce(p_details, '{}'::jsonb))
$$;

create or replace function private.contact_name(p_inquiry uuid)
returns text language sql stable security definer set search_path = '' as $$
  select c.name from public.inquiries i join public.contacts c on c.id = i.contact_id where i.id = p_inquiry
$$;

create or replace function private.stage_key_of(p_inquiry uuid)
returns public.stage_key language sql stable security definer set search_path = '' as $$
  select s.system_key from public.inquiries i join public.stages s on s.id = i.stage_id where i.id = p_inquiry
$$;

create or replace function private.ensure_not_dnc(p_inquiry uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.inquiries i join public.contacts c on c.id = i.contact_id
             where i.id = p_inquiry and c.do_not_contact) then
    perform private.fail('This customer is marked Do Not Contact.');
  end if;
end $$;

-- Validates one custom field value and returns it in canonical JSON form.
-- Returns NULL for an empty value (the stored value is then removed).
create or replace function private.validate_field_value(p_field public.field_definitions, p_value jsonb, p_current jsonb default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  t text := jsonb_typeof(p_value);
  s text;
begin
  if p_value is null or t = 'null' or (t = 'string' and trim(p_value #>> '{}') = '') then
    return null;
  end if;
  s := p_value #>> '{}';
  case p_field.type
    when 'text' then
      if length(s) > 500 then perform private.fail(p_field.label || ' is too long (500 characters at most).'); end if;
      return to_jsonb(trim(s));
    when 'phone' then
      if regexp_replace(s, '[^0-9]', '', 'g') !~ '^[0-9]{8,15}$' then
        perform private.fail(p_field.label || ': enter a valid phone number (8–15 digits).');
      end if;
      return to_jsonb(trim(s));
    when 'number' then
      if s !~ '^-?[0-9]+(\.[0-9]+)?$' then perform private.fail(p_field.label || ': enter a number.'); end if;
      return to_jsonb(s::numeric);
    when 'date' then
      if s !~ '^\d{4}-\d{2}-\d{2}$' then perform private.fail(p_field.label || ': enter a date.'); end if;
      begin
        perform s::date;
      exception when others then
        perform private.fail(p_field.label || ': enter a valid date.');
      end;
      return to_jsonb(s);
    when 'checkbox' then
      if t <> 'boolean' then perform private.fail(p_field.label || ': must be yes or no.'); end if;
      return p_value;
    when 'dropdown' then
      if not exists (
        select 1 from public.field_options o
        where o.field_id = p_field.id and o.id::text = s
          and (not o.archived or p_current #>> '{}' = s)
      ) then
        perform private.fail(p_field.label || ': choose one of the listed options.');
      end if;
      return to_jsonb(s);
  end case;
  return null;
end $$;

-- Writes several custom field values for an inquiry, checking each field's permissions.
create or replace function private.write_field_values(p_inquiry uuid, p_values jsonb, p_role public.app_role)
returns text[] language plpgsql security definer set search_path = '' as $$
declare
  k text;
  f public.field_definitions;
  v jsonb;
  cur jsonb;
  prog uuid;
  changed text[] := '{}';
begin
  if p_values is null or jsonb_typeof(p_values) <> 'object' then return changed; end if;
  select program_id into prog from public.inquiries where id = p_inquiry;
  for k in select jsonb_object_keys(p_values) loop
    select * into f from public.field_definitions where id::text = k;
    if not found then perform private.fail('Unknown field.'); end if;
    if f.archived then perform private.fail(f.label || ' is archived and cannot be changed.'); end if;
    if cardinality(f.program_ids) > 0 and not (prog = any (f.program_ids)) then
      perform private.fail(f.label || ' does not apply to this program.');
    end if;
    if not (p_role = any (f.editable_by)) then
      raise exception using errcode = 'CRM03', message = 'You cannot edit ' || f.label || '.';
    end if;
    select value into cur from public.field_values where inquiry_id = p_inquiry and field_id = f.id;
    v := private.validate_field_value(f, p_values -> k, cur);
    if v is null then
      if cur is not null then
        delete from public.field_values where inquiry_id = p_inquiry and field_id = f.id;
        changed := changed || f.label;
      end if;
    elsif cur is distinct from v then
      insert into public.field_values (inquiry_id, field_id, value, updated_at, updated_by)
      values (p_inquiry, f.id, v, now(), auth.uid())
      on conflict (inquiry_id, field_id) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
      changed := changed || f.label;
    end if;
  end loop;
  return changed;
end $$;

-- Labels of required custom fields that are still empty for a target stage.
-- Lost and Invalid never require fields, so closing a lead is never blocked.
create or replace function private.missing_required(p_inquiry uuid, p_target public.stage_key)
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(f.label order by f.sort), '{}')
  from public.inquiries i
  join public.field_definitions f
    on not f.archived
   and (cardinality(f.program_ids) = 0 or i.program_id = any (f.program_ids))
  left join public.field_values v on v.inquiry_id = i.id and v.field_id = f.id
  where i.id = p_inquiry
    and p_target not in ('lost', 'invalid')
    and (
      f.required_from = 'always'
      or (f.required_from <> 'never'
          and (select sort from public.stages where system_key = p_target)
              >= (select sort from public.stages where system_key::text = f.required_from))
    )
    and (v.value is null or v.value = 'false'::jsonb or v.value = '""'::jsonb)
$$;

-- ── Creating inquiries ───────────────────────────────────────────────────

-- p jsonb: name, phone, phone_normalized, program_id, contact_type, student_name,
--          phone_secondary, phone_secondary_normalized, assign_to (manager only), custom {field_id: value}
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
    v_owner := me; -- Phase 3 adds: only when on shift for this program, otherwise queued.
  else
    v_owner := nullif(p ->> 'assign_to', '')::uuid;
    if v_owner is not null and not exists (select 1 from public.profiles where id = v_owner and role = 'sales' and active) then
      perform private.fail('Choose an active sales agent, or leave the inquiry in the queue.');
    end if;
  end if;

  insert into public.inquiries (contact_id, program_id, student_name, stage_id, sales_owner_id, source, created_by, assigned_at)
  values (v_contact, v_program.id, v_student, (select id from public.stages where system_key = 'new'),
          v_owner, 'manual', me, case when v_owner is not null then now() end)
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
    perform private.log_activity(v_id, 'owner_change', 'Waiting in the unassigned queue');
  end if;

  return jsonb_build_object('inquiry_id', v_id, 'queued', v_owner is null, 'matched_existing', v_existing);
end $$;

-- ── Working an inquiry ───────────────────────────────────────────────────

create or replace function public.change_stage(p_inquiry uuid, p_stage public.stage_key, p_expected_version integer, p_lost_reason text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  q public.inquiries := private.inquiry_for_work(p_inquiry);
  my public.app_role := private.my_role();
  target public.stages;
  v_missing text[];
begin
  perform private.check_version(q, p_expected_version);
  select * into target from public.stages where system_key = p_stage;
  if target.id = q.stage_id then return q.version; end if;
  if not target.agent_selectable and my <> 'manager' then
    perform private.fail(target.label || ' is set automatically when payment is confirmed.');
  end if;
  if p_stage = 'lost' and coalesce(trim(p_lost_reason), '') = '' then
    perform private.fail('Add a reason before closing this lead as Lost.');
  end if;
  v_missing := private.missing_required(p_inquiry, p_stage);
  if cardinality(v_missing) > 0 then
    perform private.fail('Fill in required fields before moving to ' || target.label || '.', to_jsonb(v_missing)::text);
  end if;
  update public.inquiries set
    stage_id = target.id,
    lost_reason = case when p_stage = 'lost' then trim(p_lost_reason) else lost_reason end,
    version = version + 1
  where id = p_inquiry;
  perform private.log_activity(p_inquiry, 'stage_change',
    case when p_stage = 'lost' then 'Lost reason: ' || trim(p_lost_reason) end, jsonb_build_object('to', p_stage));
  return q.version + 1;
end $$;

create or replace function public.record_contact_attempt(p_inquiry uuid, p_outcome uuid, p_body text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare q public.inquiries := private.inquiry_for_work(p_inquiry);
begin
  perform private.ensure_not_dnc(p_inquiry);
  if not exists (select 1 from public.contact_outcomes where id = p_outcome) then
    perform private.fail('Choose the outcome.');
  end if;
  update public.inquiries set
    last_outcome_id = p_outcome,
    last_contact_at = now(),
    first_contact_attempt_at = coalesce(first_contact_attempt_at, now()),
    version = version + 1
  where id = p_inquiry;
  if private.stage_key_of(p_inquiry) = 'new' then
    update public.inquiries set stage_id = (select id from public.stages where system_key = 'contacting') where id = p_inquiry;
    perform private.log_activity(p_inquiry, 'stage_change', null, jsonb_build_object('to', 'contacting'));
  end if;
  perform private.log_activity(p_inquiry, 'contact_attempt', p_body, jsonb_build_object('outcome_id', p_outcome));
end $$;

-- Opening Call/WhatsApp is logged, but never counts as a contact attempt.
create or replace function public.log_outreach_shortcut(p_inquiry uuid, p_channel text)
returns void language plpgsql security definer set search_path = '' as $$
declare q public.inquiries := private.inquiry_for_work(p_inquiry);
begin
  perform private.ensure_not_dnc(p_inquiry);
  if p_channel not in ('call', 'whatsapp') then perform private.fail('Unknown channel.'); end if;
  perform private.log_activity(p_inquiry, 'outreach_shortcut',
    'Opened ' || case p_channel when 'call' then 'Call' else 'WhatsApp' end || ' shortcut. No outcome recorded yet.');
end $$;

create or replace function public.add_note(p_inquiry uuid, p_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare q public.inquiries := private.inquiry_for_work(p_inquiry);
begin
  if coalesce(trim(p_body), '') = '' then perform private.fail('Write a note first.'); end if;
  if length(p_body) > 4000 then perform private.fail('Notes can be 4,000 characters at most.'); end if;
  return private.log_activity(p_inquiry, 'comment', p_body);
end $$;

-- Authors may edit their own note within the configured window. The earlier text is kept.
create or replace function public.edit_note(p_activity uuid, p_body text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  a public.activities;
  win integer := (select note_edit_window_minutes from public.app_settings where id = 1);
begin
  perform private.require_role('manager', 'sales', 'support');
  select * into a from public.activities where id = p_activity for update;
  if not found or a.type <> 'comment' or a.actor_id is distinct from auth.uid() then
    raise exception using errcode = 'CRM03', message = 'Only the author can edit this note.';
  end if;
  if now() - a.created_at > make_interval(mins => win) then
    perform private.fail(format('Notes can be edited for %s minutes after posting.', win));
  end if;
  if coalesce(trim(p_body), '') = '' then perform private.fail('A note cannot be empty.'); end if;
  insert into public.note_revisions (activity_id, body, edited_by) values (a.id, a.body, auth.uid());
  update public.activities set body = trim(p_body) where id = a.id;
end $$;

create or replace function public.set_tags(p_inquiry uuid, p_tag_ids uuid[], p_primary uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  q public.inquiries := private.inquiry_for_work(p_inquiry);
  names text;
begin
  p_tag_ids := coalesce(p_tag_ids, '{}');
  if exists (
    select 1 from unnest(p_tag_ids) t(id)
    left join public.tags g on g.id = t.id
    where g.id is null
       or (g.archived and not exists (select 1 from public.inquiry_tags x where x.inquiry_id = p_inquiry and x.tag_id = g.id))
  ) then
    perform private.fail('One of the tags no longer exists or is archived.');
  end if;
  delete from public.inquiry_tags where inquiry_id = p_inquiry and not (tag_id = any (p_tag_ids));
  insert into public.inquiry_tags (inquiry_id, tag_id)
  select p_inquiry, t from unnest(p_tag_ids) t on conflict do nothing;
  update public.inquiries set
    primary_tag_id = case when p_primary = any (p_tag_ids) then p_primary end,
    version = version + 1
  where id = p_inquiry;
  select string_agg(name, ', ' order by name) into names from public.tags where id = any (p_tag_ids);
  perform private.log_activity(p_inquiry, 'tag_change', coalesce('Tags: ' || names, 'Tags cleared'));
end $$;

create or replace function public.set_do_not_contact(p_inquiry uuid, p_on boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  q public.inquiries := private.inquiry_for_work(p_inquiry);
  c public.contacts;
  n integer;
begin
  select * into c from public.contacts where id = q.contact_id for update;
  if not p_on and not private.is_manager() then
    raise exception using errcode = 'CRM03', message = 'Only a manager can remove Do Not Contact.';
  end if;
  if p_on and coalesce(trim(p_reason), '') = '' then perform private.fail('Add a reason.'); end if;
  update public.contacts set
    do_not_contact = p_on,
    do_not_contact_reason = case when p_on then trim(p_reason) end,
    updated_at = now()
  where id = c.id;
  if p_on then
    -- Outreach stops: open sales follow-ups for this person are cancelled (logged, not deleted).
    update public.follow_ups f set status = 'cancelled', completed_at = now(), completed_by = auth.uid()
    from public.inquiries i
    where f.inquiry_id = i.id and i.contact_id = c.id and f.status = 'open';
    get diagnostics n = row_count;
  end if;
  perform private.log_activity(p_inquiry, 'do_not_contact',
    case when p_on then 'Do Not Contact: ' || trim(p_reason) || case when n > 0 then format(' (%s open follow-up(s) cancelled)', n) else '' end
         else 'Do Not Contact removed' end);
  perform private.audit(case when p_on then 'Set Do Not Contact' else 'Removed Do Not Contact' end, c.name);
end $$;

create or replace function public.set_reserved(p_inquiry uuid, p_reserved boolean, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare q public.inquiries := private.inquiry_for_work(p_inquiry);
begin
  update public.inquiries set reserved = p_reserved, reserved_note = case when p_reserved then nullif(trim(p_note), '') end, version = version + 1
  where id = p_inquiry;
  perform private.log_activity(p_inquiry, 'reservation',
    case when p_reserved then 'Marked as Reserved (not a payment)' || coalesce(': ' || nullif(trim(p_note), ''), '') else 'Reservation removed' end);
end $$;

create or replace function public.set_field_values(p_inquiry uuid, p_values jsonb, p_expected_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  q public.inquiries := private.inquiry_for_work(p_inquiry);
  changed text[];
begin
  perform private.check_version(q, p_expected_version);
  changed := private.write_field_values(p_inquiry, p_values, private.my_role());
  if cardinality(changed) = 0 then return q.version; end if;
  update public.inquiries set version = version + 1 where id = p_inquiry;
  perform private.log_activity(p_inquiry, 'field_change', 'Updated ' || array_to_string(changed, ', '));
  return q.version + 1;
end $$;

-- ── Follow-ups ───────────────────────────────────────────────────────────

create or replace function public.create_follow_up(p_inquiry uuid, p_due timestamptz, p_note text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  q public.inquiries := private.inquiry_for_work(p_inquiry);
  v_id uuid;
begin
  perform private.ensure_not_dnc(p_inquiry);
  if p_due is null then perform private.fail('Choose a date and time.'); end if;
  if coalesce(trim(p_note), '') = '' then perform private.fail('Describe what to do.'); end if;
  if p_due < now() - interval '1 day' then perform private.fail('The follow-up date is in the past.'); end if;
  insert into public.follow_ups (inquiry_id, owner_id, due_at, note, created_by)
  values (p_inquiry, coalesce(q.sales_owner_id, auth.uid()), p_due, trim(p_note), auth.uid())
  returning id into v_id;
  update public.inquiries set no_follow_up_reason = null where id = p_inquiry;
  perform private.log_activity(p_inquiry, 'follow_up_created', p_note, jsonb_build_object('due_at', p_due));
  return v_id;
end $$;

create or replace function public.complete_follow_up(p_follow_up uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare f public.follow_ups;
begin
  perform private.require_role('manager', 'sales');
  select * into f from public.follow_ups where id = p_follow_up for update;
  if not found or not private.can_work_inquiry(f.inquiry_id) then
    raise exception using errcode = 'CRM04', message = 'This follow-up does not exist or is not yours.';
  end if;
  if f.status <> 'open' then perform private.fail('This follow-up is already closed.'); end if;
  update public.follow_ups set status = 'done', completed_at = now(), completed_by = auth.uid() where id = f.id;
  perform private.log_activity(f.inquiry_id, 'follow_up_completed', f.note);
end $$;

create or replace function public.set_no_follow_up_reason(p_inquiry uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare q public.inquiries := private.inquiry_for_work(p_inquiry);
begin
  if coalesce(trim(p_reason), '') = '' then perform private.fail('Add a reason.'); end if;
  update public.inquiries set no_follow_up_reason = trim(p_reason) where id = p_inquiry;
  perform private.log_activity(p_inquiry, 'comment', 'No follow-up needed: ' || trim(p_reason));
end $$;

-- ── Ownership ────────────────────────────────────────────────────────────

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
  update public.inquiries set sales_owner_id = p_to, assigned_at = now(), version = version + 1 where id = p_inquiry;
  -- Open follow-ups move with the lead. Rotation order is not touched.
  update public.follow_ups set owner_id = p_to where inquiry_id = p_inquiry and status = 'open';
  perform private.log_activity(p_inquiry, 'owner_change', 'Reassigned: ' || trim(p_reason),
    jsonb_build_object('from', q.sales_owner_id, 'to', p_to));
  perform private.notify(p_to, 'Lead reassigned to you: ' || private.contact_name(p_inquiry), p_inquiry);
  perform private.audit('Reassigned lead to ' || v_name || ' (' || trim(p_reason) || ')', private.contact_name(p_inquiry));
end $$;

-- ── Tags ─────────────────────────────────────────────────────────────────

create or replace function public.create_tag(p_name text, p_color text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  my public.app_role := private.require_role('manager', 'sales');
  v_id uuid;
begin
  if my = 'sales' and not (select agents_can_create_tags from public.app_settings where id = 1) then
    raise exception using errcode = 'CRM03', message = 'Only managers can create tags.';
  end if;
  if coalesce(trim(p_name), '') = '' then perform private.fail('Name the tag.'); end if;
  if exists (select 1 from public.tags where lower(name) = lower(trim(p_name))) then
    perform private.fail('A tag with this name already exists.');
  end if;
  insert into public.tags (name, color, created_by) values (trim(p_name), p_color, auth.uid()) returning id into v_id;
  return v_id;
end $$;

create or replace function public.update_tag(p_id uuid, p_name text, p_color text, p_archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_role('manager');
  if exists (select 1 from public.tags where lower(name) = lower(trim(p_name)) and id <> p_id) then
    perform private.fail('A tag with this name already exists.');
  end if;
  update public.tags set name = trim(p_name), color = p_color, archived = p_archived where id = p_id;
  if not found then raise exception using errcode = 'CRM04', message = 'Tag not found.'; end if;
end $$;

-- ── Custom field settings ────────────────────────────────────────────────

-- p jsonb: id?, label, type, importance, required_from, program_ids[], visible_to[], editable_by[],
--          options [{id?, label, archived}]
create or replace function public.save_field_definition(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  f public.field_definitions;
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_key text;
  v_type public.field_type := (p ->> 'type')::public.field_type;
  o jsonb;
  bad integer := 0;
  r record;
  i integer := 0;
begin
  perform private.require_role('manager');
  if coalesce(trim(p ->> 'label'), '') = '' then perform private.fail('Add a display label.'); end if;

  if v_id is not null then
    select * into f from public.field_definitions where id = v_id for update;
    if not found then raise exception using errcode = 'CRM04', message = 'Field not found.'; end if;
  else
    v_key := trim(both '_' from regexp_replace(lower(p ->> 'label'), '[^a-z0-9]+', '_', 'g'));
    if v_key = '' or v_key !~ '^[a-z]' then v_key := 'field_' || v_key; end if;
    v_key := left(v_key, 30);
    while exists (select 1 from public.field_definitions where key = v_key) loop
      v_key := left(v_key, 26) || '_' || substr(md5(random()::text), 1, 3);
    end loop;
    insert into public.field_definitions (key, label, type, sort)
    values (v_key, trim(p ->> 'label'), v_type, coalesce((select max(sort) from public.field_definitions), 0) + 1)
    returning * into f;
    v_id := f.id;
  end if;

  -- Options first, so dropdown values can be checked against them.
  for o in select * from jsonb_array_elements(coalesce(p -> 'options', '[]'::jsonb)) loop
    i := i + 1;
    if coalesce(trim(o ->> 'label'), '') = '' then perform private.fail('Option labels cannot be empty.'); end if;
    if nullif(o ->> 'id', '') is not null and exists (select 1 from public.field_options where id::text = o ->> 'id' and field_id = v_id) then
      update public.field_options set label = trim(o ->> 'label'), archived = coalesce((o ->> 'archived')::boolean, false), sort = i
      where id::text = o ->> 'id';
    else
      insert into public.field_options (field_id, label, sort, archived)
      values (v_id, trim(o ->> 'label'), i, coalesce((o ->> 'archived')::boolean, false));
    end if;
  end loop;
  if v_type = 'dropdown' and not exists (select 1 from public.field_options where field_id = v_id and not archived) then
    perform private.fail('Add at least one option.');
  end if;

  -- A type change must not silently discard data: every stored value has to convert.
  if f.type is distinct from v_type then
    update public.field_definitions set type = v_type where id = v_id returning * into f;
    for r in select value from public.field_values where field_id = v_id loop
      begin
        perform private.validate_field_value(f, r.value, r.value);
      exception when sqlstate 'CRM01' then
        bad := bad + 1;
      end;
    end loop;
    if bad > 0 then
      perform private.fail(format('%s existing value(s) cannot convert to %s. Nothing was changed.', bad, v_type));
    end if;
    update public.field_values v set value = private.validate_field_value(f, v.value, v.value) where field_id = v_id;
  end if;

  if f.label <> trim(p ->> 'label') then
    perform private.audit(format('Renamed field "%s" → "%s"', f.label, trim(p ->> 'label')), 'Customer Fields');
  elsif (p ->> 'id') is null then
    perform private.audit(format('Added field "%s"', trim(p ->> 'label')), 'Customer Fields');
  end if;

  update public.field_definitions set
    label = trim(p ->> 'label'),
    importance = coalesce((p ->> 'importance')::public.field_importance, importance),
    required_from = coalesce(p ->> 'required_from', required_from),
    program_ids = coalesce(array(select jsonb_array_elements_text(p -> 'program_ids'))::uuid[], '{}'),
    visible_to = array(select jsonb_array_elements_text(p -> 'visible_to'))::public.app_role[],
    editable_by = array(select jsonb_array_elements_text(p -> 'editable_by'))::public.app_role[]
  where id = v_id;
  return v_id;
exception
  when check_violation then
    perform private.fail('Managers must always see every field, and only roles that can see a field can edit it.');
    return null;
end $$;

create or replace function public.set_field_archived(p_id uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_label text;
begin
  perform private.require_role('manager');
  update public.field_definitions set archived = p_archived where id = p_id returning label into v_label;
  if v_label is null then raise exception using errcode = 'CRM04', message = 'Field not found.'; end if;
  perform private.audit(case when p_archived then 'Archived field' else 'Restored field' end, v_label);
end $$;

create or replace function public.move_field(p_id uuid, p_dir integer)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.field_definitions; b public.field_definitions;
begin
  perform private.require_role('manager');
  select * into a from public.field_definitions where id = p_id;
  select * into b from public.field_definitions
  where not archived and case when p_dir < 0 then sort < a.sort else sort > a.sort end
  order by case when p_dir < 0 then -sort else sort end limit 1;
  if b.id is null then return; end if;
  update public.field_definitions set sort = b.sort where id = a.id;
  update public.field_definitions set sort = a.sort where id = b.id;
end $$;

-- ── Stages and outcomes ──────────────────────────────────────────────────

create or replace function public.rename_stage(p_id uuid, p_label text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_role('manager');
  if coalesce(trim(p_label), '') = '' then perform private.fail('Label cannot be empty.'); end if;
  update public.stages set label = trim(p_label) where id = p_id;
end $$;

create or replace function public.move_stage(p_id uuid, p_dir integer)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.stages; b public.stages;
begin
  perform private.require_role('manager');
  select * into a from public.stages where id = p_id;
  if a.is_closed then perform private.fail('Closed stages keep their place at the end.'); end if;
  select * into b from public.stages
  where not is_closed and case when p_dir < 0 then sort < a.sort else sort > a.sort end
  order by case when p_dir < 0 then -sort else sort end limit 1;
  if b.id is null then return; end if;
  update public.stages set sort = b.sort where id = a.id;
  update public.stages set sort = a.sort where id = b.id;
end $$;

create or replace function public.rename_outcome(p_id uuid, p_label text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_role('manager');
  if coalesce(trim(p_label), '') = '' then perform private.fail('Label cannot be empty.'); end if;
  update public.contact_outcomes set label = trim(p_label) where id = p_id;
end $$;

-- ── Programs and cohorts ─────────────────────────────────────────────────

create or replace function public.save_cohort(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  perform private.require_role('manager');
  if coalesce(trim(p ->> 'name'), '') = '' then perform private.fail('Name the course or cohort.'); end if;
  if v_id is null then
    insert into public.cohorts (program_id, name, start_date, default_price, currency, active)
    values ((p ->> 'program_id')::uuid, trim(p ->> 'name'), nullif(p ->> 'start_date', '')::date,
            nullif(p ->> 'default_price', '')::numeric, coalesce(nullif(p ->> 'currency', ''), 'EGP'), coalesce((p ->> 'active')::boolean, true))
    returning id into v_id;
  else
    update public.cohorts set name = trim(p ->> 'name'), start_date = nullif(p ->> 'start_date', '')::date,
      default_price = nullif(p ->> 'default_price', '')::numeric, currency = coalesce(nullif(p ->> 'currency', ''), 'EGP'),
      active = coalesce((p ->> 'active')::boolean, true)
    where id = v_id;
  end if;
  return v_id;
end $$;

-- ── Settings ─────────────────────────────────────────────────────────────

create or replace function public.update_settings(p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_role('manager');
  update public.app_settings set
    agents_can_create_tags = coalesce((p ->> 'agents_can_create_tags')::boolean, agents_can_create_tags),
    agents_can_pause = coalesce((p ->> 'agents_can_pause')::boolean, agents_can_pause),
    per_agent_lead_cap_enabled = coalesce((p ->> 'per_agent_lead_cap_enabled')::boolean, per_agent_lead_cap_enabled),
    reminder_minutes_before = coalesce((p ->> 'reminder_minutes_before')::integer, reminder_minutes_before),
    overdue_after_minutes = coalesce((p ->> 'overdue_after_minutes')::integer, overdue_after_minutes),
    first_contact_target_minutes = coalesce((p ->> 'first_contact_target_minutes')::integer, first_contact_target_minutes),
    note_edit_window_minutes = coalesce((p ->> 'note_edit_window_minutes')::integer, note_edit_window_minutes),
    handover_trigger = coalesce(p ->> 'handover_trigger', handover_trigger),
    deposit_rule = coalesce(p -> 'deposit_rule', deposit_rule),
    updated_at = now()
  where id = 1;
  perform private.audit('Changed settings', 'Settings', p);
exception
  when check_violation then perform private.fail('One of the values is outside the allowed range.');
end $$;

-- ── Staff accounts ───────────────────────────────────────────────────────

-- Called by the server right after the Supabase invitation creates the login.
create or replace function public.admin_create_profile(p_user uuid, p_name text, p_email text, p_role public.app_role)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_role('manager');
  if coalesce(trim(p_name), '') = '' then perform private.fail('Add the person''s name.'); end if;
  insert into public.profiles (id, full_name, email, role, rotation_order)
  values (p_user, trim(p_name), lower(trim(p_email)), p_role,
          case when p_role = 'sales' then coalesce((select max(rotation_order) from public.profiles), 0) + 1 else 0 end)
  on conflict (id) do update set full_name = excluded.full_name, role = excluded.role, active = true;
  perform private.audit('Invited user as ' || p_role, trim(p_name));
end $$;

create or replace function public.set_user_active(p_user uuid, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  perform private.require_role('manager');
  update public.profiles set active = p_active where id = p_user returning full_name into v_name;
  if v_name is null then raise exception using errcode = 'CRM04', message = 'User not found.'; end if;
  perform private.audit(case when p_active then 'Reactivated user' else 'Deactivated user' end, v_name);
end $$;

create or replace function public.set_user_role(p_user uuid, p_role public.app_role)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old public.app_role; v_name text;
begin
  perform private.require_role('manager');
  select role, full_name into v_old, v_name from public.profiles where id = p_user;
  if v_name is null then raise exception using errcode = 'CRM04', message = 'User not found.'; end if;
  if v_old = p_role then return; end if;
  update public.profiles set role = p_role where id = p_user;
  perform private.audit(format('Changed role %s → %s', v_old, p_role), v_name);
end $$;

create or replace function public.set_user_lead_cap(p_user uuid, p_cap integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_role('manager');
  if p_cap is not null and p_cap < 1 then perform private.fail('The limit must be at least 1.'); end if;
  update public.profiles set max_open_leads = p_cap where id = p_user;
end $$;

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
  update public.profiles set paused = p_paused where id = p_user and role = 'sales' returning full_name into v_name;
  if v_name is null then perform private.fail('Only sales agents can be paused.'); end if;
  perform private.audit(case when p_paused then 'Paused new leads' else 'Resumed new leads' end, v_name);
end $$;

create or replace function public.mark_notifications_read()
returns void language sql security definer set search_path = '' as $$
  update public.notifications set read_at = now() where user_id = auth.uid() and read_at is null
$$;

-- First manager, run once by the Academy from the Supabase SQL editor (never by staff).
create or replace function private.bootstrap_first_manager(p_email text, p_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  if exists (select 1 from public.profiles where role = 'manager' and active) then
    raise exception 'A manager already exists. Invite more staff from Settings → Users and Roles.';
  end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'No login with that email yet. Invite it first in Supabase → Authentication → Users.';
  end if;
  insert into public.profiles (id, full_name, email, role) values (v_user, trim(p_name), lower(trim(p_email)), 'manager');
end $$;

-- ── Execute permissions ──────────────────────────────────────────────────
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;
revoke execute on function private.bootstrap_first_manager(text, text) from authenticated;
