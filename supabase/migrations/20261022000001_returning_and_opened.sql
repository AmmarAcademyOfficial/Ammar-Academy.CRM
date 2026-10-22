-- ===== Step 1 · 22 Oct 2026 =====
-- 1. Returning customers: a new inquiry for a known phone number goes to the agent who owned
--    that person's most recent inquiry (assign_next), with a notification. Phones match on the
--    main or the second number, either way round.
-- 2. "Not opened yet": inquiries and onboardings remember when their owner first opened them.
--    The screens highlight unopened ones. A new owner starts unopened again.
-- Additive: two nullable columns, one allowed value, new functions; existing rows backfilled.

-- ── Columns ──────────────────────────────────────────────────────────────
alter table public.inquiries add column if not exists owner_opened_at timestamptz;
alter table public.onboardings add column if not exists support_opened_at timestamptz;

alter table public.inquiries drop constraint if exists inquiries_assignment_method_check;
alter table public.inquiries add constraint inquiries_assignment_method_check
  check (assignment_method in ('round_robin', 'manual', 'creator', 'returning'));

create index if not exists inquiries_unopened_idx on public.inquiries (sales_owner_id) where owner_opened_at is null;

-- Existing data: only open leads that nobody has tried to contact yet start as "not opened".
update public.inquiries i
   set owner_opened_at = coalesce(i.first_contact_attempt_at, i.assigned_at, i.created_at)
 where i.owner_opened_at is null
   and (i.sales_owner_id is null
        or i.first_contact_attempt_at is not null
        or exists (select 1 from public.stages s where s.id = i.stage_id and s.is_closed));
update public.inquiries set owner_opened_at = null where sales_owner_id is null;
-- Customers support has already taken on count as opened.
update public.onboardings set support_opened_at = claimed_at where support_opened_at is null and claimed_at is not null;

-- ── A new owner starts "not opened" (unless they gave it to themselves) ──
create or replace function private.reset_owner_opened()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.sales_owner_id is distinct from old.sales_owner_id then
    new.owner_opened_at := case when new.sales_owner_id is not null and new.sales_owner_id = auth.uid() then now() end;
  end if;
  return new;
end $$;
drop trigger if exists inquiries_reset_opened on public.inquiries;
create trigger inquiries_reset_opened before insert or update of sales_owner_id on public.inquiries
  for each row execute function private.reset_owner_opened();

create or replace function private.reset_support_opened()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.support_owner_id is distinct from old.support_owner_id then
    new.support_opened_at := case when new.support_owner_id is not null and new.support_owner_id = auth.uid() then now() end;
  end if;
  return new;
end $$;
drop trigger if exists onboardings_reset_opened on public.onboardings;
create trigger onboardings_reset_opened before update of support_owner_id on public.onboardings
  for each row execute function private.reset_support_opened();

-- ── Opening clears the highlight (owner only; no version bump, so nobody's edit conflicts) ──
create or replace function public.mark_inquiry_opened(p_inquiry uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.inquiries set owner_opened_at = now()
   where id = p_inquiry and sales_owner_id = auth.uid() and owner_opened_at is null;
  return found;
end $$;

create or replace function public.mark_onboarding_opened(p_inquiry uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.onboardings o set support_opened_at = now()
    from public.enrollments e
   where e.id = o.enrollment_id and e.inquiry_id = p_inquiry
     and o.support_owner_id = auth.uid() and o.support_opened_at is null;
  return found;
end $$;

-- ── Phone matching ───────────────────────────────────────────────────────
create or replace function private.find_contact_by_phone(p_main text, p_secondary text default null)
returns uuid language sql stable security definer set search_path = '' as $$
  select c.id from public.contacts c
  where c.phone_normalized = p_main
     or c.phone_secondary_normalized = p_main
     or (p_secondary is not null and (c.phone_normalized = p_secondary or c.phone_secondary_normalized = p_secondary))
  order by (c.phone_normalized = p_main) desc, (c.phone_secondary_normalized = p_main) desc, c.created_at
  limit 1
$$;

-- ── Returning-customer label and the list of earlier inquiries ───────────
-- Existence only, so an agent sees "Returning customer" even when the earlier lead was someone else's.
create or replace function private.has_earlier_inquiry(p_contact uuid, p_inquiry uuid, p_created timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.inquiries x where x.contact_id = p_contact and x.id <> p_inquiry and x.created_at < p_created)
$$;

-- Earlier inquiries of the same customer, for anyone who may see this inquiry. "visible" says
-- whether the caller may open that earlier inquiry too.
create or replace function public.earlier_inquiries(p_inquiry uuid)
returns table (inquiry_id uuid, program_code text, created_at timestamptz, owner_name text, stage_label text, visible boolean)
language sql stable security definer set search_path = '' as $$
  select x.id, pr.code, x.created_at, p.full_name, s.label,
         (private.my_role() = 'manager' or x.id in (select private.my_inquiry_ids()))
  from public.inquiries q
  join public.inquiries x on x.contact_id = q.contact_id and x.id <> q.id and x.created_at < q.created_at
  join public.programs pr on pr.id = x.program_id
  join public.stages s on s.id = x.stage_id
  left join public.profiles p on p.id = x.sales_owner_id
  where q.id = p_inquiry
    and (private.my_role() = 'manager' or p_inquiry in (select private.my_inquiry_ids()))
  order by x.created_at desc
  limit 20
$$;

-- ── Contacts: match on main or second phone ─────────────────────────────
create or replace function private.create_imported_inquiry(p jsonb, p_connection uuid, p_row_number integer, p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.sheet_connections;
  v_contact uuid;
  v_existing boolean := false;
  v_student text := nullif(trim(p ->> 'student_name'), '');
  v_program uuid := (p ->> 'program_id')::uuid;
  v_dup public.inquiries;
  v_id uuid;
  v_created timestamptz;
  v_source text;
  k text;
  f public.field_definitions;
  v jsonb;
  v_skipped text[] := '{}';
begin
  select * into c from public.sheet_connections where id = p_connection;
  v_source := coalesce(c.spreadsheet_name || ' · ' || c.sheet_title, 'Google Sheet')
              || coalesce(' (row ' || p_row_number || ')', '');
  if coalesce(trim(p ->> 'name'), '') = '' then perform private.fail('Name is required.'); end if;
  if coalesce(p ->> 'phone_normalized', '') !~ '^\+?[0-9]{8,15}$' then perform private.fail('Enter a valid phone number.'); end if;
  if not exists (select 1 from public.programs where id = v_program and active) then perform private.fail('Choose a program.'); end if;

  -- A known number (main or second phone, either way round) is the same customer.
  v_contact := private.find_contact_by_phone(p ->> 'phone_normalized', nullif(p ->> 'phone_secondary_normalized', ''));
  if v_contact is not null then
    v_existing := true;
  else
    insert into public.contacts (name, phone, phone_normalized, phone_secondary, phone_secondary_normalized, contact_type, created_by)
    values (left(trim(p ->> 'name'), 120), trim(p ->> 'phone'), p ->> 'phone_normalized',
            nullif(trim(p ->> 'phone_secondary'), ''), nullif(p ->> 'phone_secondary_normalized', ''),
            coalesce(nullif(p ->> 'contact_type', '')::public.contact_type, 'student'), p_actor)
    on conflict (phone_normalized) do nothing
    returning id into v_contact;
  end if;
  if v_contact is null then
    -- Existing customer: keep their saved name and details; the new row becomes a new inquiry or a resubmission.
    select id into v_contact from public.contacts where phone_normalized = p ->> 'phone_normalized';
    v_existing := true;
  end if;

  -- Same person, same program, same student, still open → a resubmission, not a second lead.
  select i.* into v_dup
  from public.inquiries i join public.stages s on s.id = i.stage_id
  where i.contact_id = v_contact and i.program_id = v_program and not s.is_closed
    and coalesce(lower(i.student_name), '') = coalesce(lower(v_student), '')
  order by i.created_at desc
  limit 1
  for update of i;
  if found then
    insert into public.activities (inquiry_id, type, actor_id, body, meta)
    values (v_dup.id, 'resubmitted', p_actor, 'Submitted the form again · ' || v_source,
            jsonb_build_object('connection_id', p_connection, 'row', p_row_number));
    if v_dup.sales_owner_id is not null then
      perform private.notify(v_dup.sales_owner_id, 'Submitted the form again: ' || private.contact_name(v_dup.id), v_dup.id);
    end if;
    return jsonb_build_object('outcome', 'resubmitted', 'inquiry_id', v_dup.id);
  end if;

  -- Historic rows keep their submission time; anything odd (future, unparsable) uses now.
  v_created := case when (p ->> 'submitted_at') is not null and (p ->> 'submitted_at')::timestamptz <= now()
                    then (p ->> 'submitted_at')::timestamptz else now() end;

  insert into public.inquiries (contact_id, program_id, student_name, stage_id, source, source_connection_id, created_by, created_at)
  values (v_contact, v_program, v_student, (select id from public.stages where system_key = 'new'),
          'google_sheet', p_connection, p_actor, v_created)
  returning id into v_id;

  -- Custom fields: a value that does not fit the field is skipped and noted, never blocking the lead.
  if jsonb_typeof(p -> 'custom') = 'object' then
    for k in select jsonb_object_keys(p -> 'custom') loop
      select * into f from public.field_definitions where id::text = k and not archived
        and (cardinality(program_ids) = 0 or v_program = any (program_ids));
      continue when not found;
      begin
        v := private.validate_field_value(f, p -> 'custom' -> k, null);
        if v is not null then
          insert into public.field_values (inquiry_id, field_id, value, updated_by) values (v_id, f.id, v, p_actor);
        end if;
      exception when sqlstate 'CRM01' then
        v_skipped := v_skipped || f.label;
      end;
    end loop;
  end if;

  insert into public.activities (inquiry_id, type, actor_id, body, meta)
  values (v_id, 'imported', p_actor,
          'Imported from ' || v_source
          || case when v_existing then ' · linked to existing contact' else '' end
          || case when cardinality(v_skipped) > 0 then ' · left empty (value did not fit): ' || array_to_string(v_skipped, ', ') else '' end,
          jsonb_build_object('connection_id', p_connection, 'row', p_row_number));
  -- Extra form answers that have no CRM field are kept on the timeline.
  if coalesce(trim(p ->> 'extra_note'), '') <> '' then
    insert into public.activities (inquiry_id, type, actor_id, body) values (v_id, 'comment', p_actor, left(p ->> 'extra_note', 4000));
  end if;

  if private.assign_next(v_id, now()) is null then
    insert into public.activities (inquiry_id, type, actor_id, body) values (v_id, 'owner_change', null, 'Waiting in the unassigned queue');
  end if;
  return jsonb_build_object('outcome', 'imported', 'inquiry_id', v_id);
end $$;

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
  -- A known number (main or second phone, either way round) is the same customer.
  v_contact := private.find_contact_by_phone(p ->> 'phone_normalized', nullif(p ->> 'phone_secondary_normalized', ''));
  if v_contact is not null then
    v_existing := true;
  else
    insert into public.contacts (name, phone, phone_normalized, phone_secondary, phone_secondary_normalized, contact_type, created_by)
    values (trim(p ->> 'name'), trim(p ->> 'phone'), p ->> 'phone_normalized',
            nullif(trim(p ->> 'phone_secondary'), ''), nullif(p ->> 'phone_secondary_normalized', ''),
            coalesce((p ->> 'contact_type')::public.contact_type, 'student'), me)
    on conflict (phone_normalized) do nothing
    returning id into v_contact;
  end if;
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
    v_owner := me; -- An agent who adds a customer keeps it.
  else
    v_owner := nullif(p ->> 'assign_to', '')::uuid;
    if v_owner is not null and not exists (select 1 from public.profiles where id = v_owner and role = 'sales' and active) then
      perform private.fail('Choose an active sales agent, or leave the inquiry in the queue.');
    end if;
  end if;

  insert into public.inquiries (contact_id, program_id, student_name, stage_id, sales_owner_id, source, created_by, assigned_at, assignment_method)
  values (v_contact, v_program.id, v_student, (select id from public.stages where system_key = 'new'),
          v_owner, 'manual', me, case when v_owner is not null then now() end,
          case when v_owner is null then null when v_owner = me then 'creator' else 'manual' end)
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
    -- No owner chosen: round-robin right away; if nobody is eligible it waits in the queue.
    v_owner := private.assign_next(v_id, now());
    if v_owner is null then
      perform private.log_activity(v_id, 'owner_change', 'Waiting in the unassigned queue');
    end if;
  end if;

  return jsonb_build_object('inquiry_id', v_id, 'queued', v_owner is null, 'matched_existing', v_existing,
                            'owner_id', v_owner);
end $$;

-- ── Assignment: returning customers first ───────────────────────────────
create or replace function private.assign_next(p_inquiry uuid, p_at timestamptz default now())
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  q public.inquiries;
  r public.rotation_state;
  v_agent public.profiles;
  v_name text;
  v_prev record;
  v_reason text;
begin
  select * into q from public.inquiries where id = p_inquiry for update;
  if not found or q.sales_owner_id is not null then return null; end if;
  if private.stage_key_of(p_inquiry) in ('enrolled', 'lost', 'invalid') then return null; end if;

  -- Returning customer: the agent who owned this person's most recent other inquiry gets it,
  -- even when off shift, paused or at their lead limit (they see it next shift), as long as they
  -- sell this program. Not when on leave, no longer an active sales agent, or the program is not
  -- on any of their shifts: then the normal turn order applies.
  -- This does not count as the agent's turn in the rotation.
  select i.id, i.sales_owner_id, i.created_at, pr.code into v_prev
  from public.inquiries i join public.programs pr on pr.id = i.program_id
  where i.contact_id = q.contact_id and i.id <> q.id and i.sales_owner_id is not null
  order by i.created_at desc
  limit 1;
  if found then
    select * into v_agent from public.profiles where id = v_prev.sales_owner_id;
    v_reason := private.ineligible_reason(v_agent.id, q.program_id, p_at);
    -- Only if they sell this program at all (one of their weekly shifts includes it).
    if (v_reason is null or v_reason in ('off_shift', 'program_not_on_shift', 'paused', 'at_capacity'))
       and exists (select 1 from public.shifts sh where sh.user_id = v_agent.id and q.program_id = any (sh.program_ids)) then
      update public.inquiries
         set sales_owner_id = v_agent.id, assigned_at = p_at, assignment_method = 'returning', version = version + 1
       where id = p_inquiry and sales_owner_id is null;
      v_name := private.contact_name(p_inquiry);
      update public.follow_ups set owner_id = v_agent.id where inquiry_id = p_inquiry and status = 'open';
      insert into public.activities (inquiry_id, type, actor_id, body, meta)
      values (p_inquiry, 'owner_change', null, 'Assigned to the previous agent (returning customer)',
              jsonb_build_object('to', v_agent.id, 'method', 'returning', 'previous_inquiry', v_prev.id));
      perform private.notify(v_agent.id,
        format('Returning customer assigned to you: %s (%s). They had a lead with you before (%s, %s).',
               v_name, (select code from public.programs where id = q.program_id),
               v_prev.code, to_char(v_prev.created_at at time zone 'Africa/Cairo', 'Mon YYYY')),
        p_inquiry);
      return v_agent.id;
    elsif v_reason in ('inactive', 'not_sales')
          and not exists (select 1 from public.activities a where a.inquiry_id = p_inquiry and a.type = 'owner_change' and a.meta ? 'to') then
      insert into public.notifications (user_id, text, inquiry_id)
      select id, format('Returning customer %s: their previous agent %s is no longer an active sales agent, so the lead goes to the normal turn order.',
                        private.contact_name(p_inquiry), v_agent.full_name), p_inquiry
      from public.profiles where role = 'manager' and active;
    end if;
    v_agent := null;
  end if;

  insert into public.rotation_state (program_id) values (q.program_id) on conflict do nothing;
  select * into r from public.rotation_state where program_id = q.program_id for update;

  -- First eligible agent after the last one, wrapping around.
  select p.* into v_agent
  from public.profiles p
  where p.role = 'sales' and p.active and private.ineligible_reason(p.id, q.program_id, p_at) is null
  order by (p.rotation_order <= coalesce(r.last_rotation_order, -2147483648)), p.rotation_order, p.created_at
  limit 1;
  if not found then return null; end if;

  update public.inquiries
     set sales_owner_id = v_agent.id, assigned_at = p_at, assignment_method = 'round_robin', version = version + 1
   where id = p_inquiry and sales_owner_id is null;
  update public.rotation_state
     set last_user_id = v_agent.id, last_rotation_order = v_agent.rotation_order, last_assigned_at = p_at
   where program_id = q.program_id;

  v_name := private.contact_name(p_inquiry);
  -- Open follow-ups (from an earlier owner) move with the lead.
  update public.follow_ups set owner_id = v_agent.id where inquiry_id = p_inquiry and status = 'open';
  -- Logged as the system even when a manager pressed "Run assignment".
  insert into public.activities (inquiry_id, type, actor_id, body, meta)
  values (p_inquiry, 'owner_change', null, 'Assigned automatically (round-robin)',
          jsonb_build_object('to', v_agent.id, 'method', 'round_robin'));
  perform private.notify(v_agent.id, 'New lead assigned: ' || v_name, p_inquiry);
  return v_agent.id;
end $$;

revoke all on function private.reset_owner_opened(), private.reset_support_opened(),
  private.find_contact_by_phone(text, text) from public, anon, authenticated;
revoke all on function private.assign_next(uuid, timestamptz), private.create_imported_inquiry(jsonb, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.mark_inquiry_opened(uuid), public.mark_onboarding_opened(uuid), public.earlier_inquiries(uuid),
  private.has_earlier_inquiry(uuid, uuid, timestamptz) to authenticated;
revoke execute on function public.mark_inquiry_opened(uuid), public.mark_onboarding_opened(uuid), public.earlier_inquiries(uuid),
  private.has_earlier_inquiry(uuid, uuid, timestamptz) from public, anon;
