-- ===== CRM changes · Part A · 26 Oct 2026 =====
-- Managers move many leads at once: to one sales agent, shared across several in turn, swapped
-- between two agents, or returned to the round-robin queue. Every move is one transaction (all or
-- nothing), up to 500 leads, with a reason.
--   * Each moved lead: owner + assigned time + 'manual' method, open follow-ups move with it, one
--     timeline line ("Moved from Nour to Youssef by Hana: <reason>").
--   * One notification per receiving agent and one per agent who loses leads (not one per lead).
--   * One audit line per action. Sales credit on enrollments never changes (original_sales_owner_id).
-- Additive: new functions and one notification rule; reassign_inquiry and redistribute are unchanged.

insert into public.notification_rules (event, role, enabled, popup) values
  ('leads_moved_away', 'sales', true, false)
on conflict (event, role) do nothing;

-- The moves to make: one row per lead, from its current owner to its new owner (null = the queue).
-- p_plan = [{"id": "<inquiry>", "to": "<profile>" | null}, …]. Leads already with their target are skipped.
create or replace function private.apply_lead_moves(p_plan jsonb, p_reason text, p_kind text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_reason text := trim(coalesce(p_reason, ''));
  v_me uuid := auth.uid();
  v_me_name text := (select full_name from public.profiles where id = auth.uid());
  v_count integer;
  v_moved integer := 0;
  v_queued integer := 0;
  r record;
  g record;
  v_result jsonb;
begin
  if v_reason = '' then perform private.fail('Add a reason, for example "Nour is on leave this week".'); end if;
  if length(v_reason) > 300 then perform private.fail('The reason is too long (300 characters at most).'); end if;
  v_count := jsonb_array_length(coalesce(p_plan, '[]'));
  if v_count = 0 then perform private.fail('Choose at least one lead.'); end if;
  if v_count > 500 then perform private.fail(format('You chose %s leads. Move up to 500 at a time.', v_count)); end if;

  create temporary table if not exists pg_temp.lead_moves (inquiry_id uuid primary key, from_id uuid, to_id uuid, closed boolean, contact text) on commit drop;
  truncate pg_temp.lead_moves;
  begin
    insert into pg_temp.lead_moves (inquiry_id, to_id)
    select (x ->> 'id')::uuid, nullif(x ->> 'to', '')::uuid from jsonb_array_elements(p_plan) x;
  exception when unique_violation then
    perform private.fail('The same lead was chosen twice.');
  end;

  -- Lock the leads (in a fixed order, so two managers moving overlapping leads cannot deadlock).
  perform 1 from public.inquiries i where i.id in (select inquiry_id from pg_temp.lead_moves) order by i.id for update;
  update pg_temp.lead_moves m set from_id = i.sales_owner_id, closed = s.is_closed, contact = c.name
    from public.inquiries i join public.stages s on s.id = i.stage_id join public.contacts c on c.id = i.contact_id
   where i.id = m.inquiry_id;
  if exists (select 1 from pg_temp.lead_moves where contact is null) then
    raise exception using errcode = 'CRM04', message = 'One of the chosen leads no longer exists. Refresh and try again.';
  end if;
  if exists (select 1 from pg_temp.lead_moves m where m.to_id is not null
             and not exists (select 1 from public.profiles p where p.id = m.to_id and p.role = 'sales' and p.active)) then
    perform private.fail('Leads can only go to active sales agents.');
  end if;
  if exists (select 1 from pg_temp.lead_moves where to_id is null and closed) then
    perform private.fail('Enrolled, lost or invalid leads cannot go back to the queue. Untick them, or move them to an agent.');
  end if;
  delete from pg_temp.lead_moves where from_id is not distinct from to_id;

  -- The moves.
  update public.inquiries i
     set sales_owner_id = m.to_id,
         assigned_at = case when m.to_id is null then null else now() end,
         assignment_method = case when m.to_id is null then null else 'manual' end,
         version = i.version + 1
    from pg_temp.lead_moves m where m.inquiry_id = i.id;
  update public.follow_ups f set owner_id = m.to_id
    from pg_temp.lead_moves m where f.inquiry_id = m.inquiry_id and f.status = 'open' and m.to_id is not null;
  insert into public.activities (inquiry_id, type, actor_id, body, meta)
  select m.inquiry_id, 'owner_change', v_me,
         case when m.to_id is null then format('Returned to the queue by %s: %s', v_me_name, v_reason)
              else format('Moved %sto %s by %s: %s',
                          coalesce('from ' || (select full_name from public.profiles where id = m.from_id) || ' ', ''),
                          (select full_name from public.profiles where id = m.to_id), v_me_name, v_reason) end,
         jsonb_build_object('from', m.from_id, 'to', m.to_id, 'bulk', p_kind)
    from pg_temp.lead_moves m;
  select count(*) filter (where to_id is not null), count(*) filter (where to_id is null) into v_moved, v_queued from pg_temp.lead_moves;

  -- One notification per receiving agent …
  for g in select to_id, count(*) as n, min(inquiry_id::text)::uuid as one, min(contact) as contact
             from pg_temp.lead_moves where to_id is not null group by to_id loop
    insert into public.notifications (user_id, text, inquiry_id, kind)
    values (g.to_id,
            case when g.n = 1 then 'Lead reassigned to you: ' || g.contact
                 else format('%s leads moved to you by %s: %s', g.n, v_me_name, v_reason) end,
            case when g.n = 1 then g.one end, 'lead_assigned');
  end loop;
  -- … and one per agent who loses leads.
  for g in select from_id, count(*) as n, min(contact) as contact,
                  string_agg(distinct coalesce((select full_name from public.profiles where id = to_id), 'the queue'), ', ') as dest
             from pg_temp.lead_moves where from_id is not null group by from_id loop
    insert into public.notifications (user_id, text, inquiry_id, kind)
    values (g.from_id,
            case when g.n = 1 then format('Lead moved to %s by %s: %s', g.dest, v_me_name, g.contact)
                 else format('%s of your leads moved to %s by %s: %s', g.n, g.dest, v_me_name, v_reason) end,
            null, 'leads_moved_away');
  end loop;

  select jsonb_build_object(
           'moved', v_moved, 'queued', v_queued, 'skipped', v_count - v_moved - v_queued,
           'agents', coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'received', x.n,
                                                           'open', private.open_lead_count(p.id), 'cap', p.max_open_leads)
                                        order by p.full_name), '[]'))
    into v_result
    from (select to_id, count(*) as n from pg_temp.lead_moves where to_id is not null group by to_id) x
    join public.profiles p on p.id = x.to_id;

  if v_moved + v_queued > 0 then
    perform private.audit(
      format('%s %s lead%s (%s)', case p_kind when 'swap' then 'Swapped' when 'queue' then 'Returned to the queue' else 'Moved' end,
             v_moved + v_queued, case when v_moved + v_queued = 1 then '' else 's' end, v_reason),
      coalesce((select string_agg(e ->> 'name' || ' +' || (e ->> 'received'), ', ') from jsonb_array_elements(v_result -> 'agents') e), 'Queue'),
      jsonb_build_object('kind', p_kind, 'moved', v_moved, 'queued', v_queued));
  end if;
  if v_queued > 0 then v_result := v_result || jsonb_build_object('assignment', private.assign_waiting(now())); end if;
  return v_result;
end $$;

-- Move chosen leads (managers). p: ids[], mode 'to' | 'share' | 'queue', to[] (one agent for 'to',
-- two or more for 'share', handed out in turn in the order given), reason.
create or replace function public.move_leads(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_mode text := coalesce(p ->> 'mode', 'to');
  v_to uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p -> 'to', '[]')) x), '{}');
  v_plan jsonb;
begin
  perform private.require_role('manager');
  if v_mode not in ('to', 'share', 'queue') then perform private.fail('Choose where the leads go.'); end if;
  if v_mode = 'to' and cardinality(v_to) <> 1 then perform private.fail('Choose the sales agent who gets the leads.'); end if;
  if v_mode = 'share' and cardinality(v_to) < 2 then perform private.fail('Choose at least two agents to share the leads.'); end if;
  if v_mode = 'share' and cardinality(v_to) <> (select count(distinct x) from unnest(v_to) x) then perform private.fail('Each agent can be chosen once.'); end if;
  -- Shared in turn, oldest lead first; a lead that already belongs to one of the chosen agents stays with them.
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id,
           'to', case v_mode when 'queue' then null
                             when 'to' then v_to[1]::text
                             else case when q.sales_owner_id = any (v_to) then q.sales_owner_id::text
                                       else v_to[1 + ((q.n - 1) % cardinality(v_to))]::text end end)), '[]')
    into v_plan
    from (select i.id, i.sales_owner_id,
                 row_number() over (partition by (i.sales_owner_id = any (v_to)) order by i.created_at, i.id) as n
            from public.inquiries i
           where i.id in (select x::uuid from jsonb_array_elements_text(coalesce(p -> 'ids', '[]')) x)) q;
  if jsonb_array_length(v_plan) <> jsonb_array_length(coalesce(p -> 'ids', '[]')) then
    if jsonb_array_length(coalesce(p -> 'ids', '[]')) > 500 then
      perform private.fail(format('You chose %s leads. Move up to 500 at a time.', jsonb_array_length(p -> 'ids')));
    end if;
    raise exception using errcode = 'CRM04', message = 'One of the chosen leads no longer exists. Refresh and try again.';
  end if;
  return private.apply_lead_moves(v_plan, p ->> 'reason', case v_mode when 'queue' then 'queue' when 'share' then 'share' else 'move' end);
end $$;

-- Swap leads between two agents (managers). p: agent_a, agent_b, a_ids[] (A's leads → B), b_ids[] (B's leads → A), reason.
create or replace function public.swap_leads(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_a uuid := nullif(p ->> 'agent_a', '')::uuid;
  v_b uuid := nullif(p ->> 'agent_b', '')::uuid;
  v_a_ids uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p -> 'a_ids', '[]')) x), '{}');
  v_b_ids uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p -> 'b_ids', '[]')) x), '{}');
begin
  perform private.require_role('manager');
  if v_a is null or v_b is null or v_a = v_b then perform private.fail('Choose two different sales agents to swap between.'); end if;
  if cardinality(v_a_ids) = 0 and cardinality(v_b_ids) = 0 then perform private.fail('Choose at least one lead.'); end if;
  if exists (select 1 from public.inquiries i where i.id = any (v_a_ids) and i.sales_owner_id is distinct from v_a)
     or exists (select 1 from public.inquiries i where i.id = any (v_b_ids) and i.sales_owner_id is distinct from v_b) then
    perform private.fail('Some of these leads have changed owner since you chose them. Refresh and try again.');
  end if;
  return private.apply_lead_moves(
    (select coalesce(jsonb_agg(jsonb_build_object('id', x, 'to', v_b)), '[]') from unnest(v_a_ids) x)
    || (select coalesce(jsonb_agg(jsonb_build_object('id', x, 'to', v_a)), '[]') from unnest(v_b_ids) x),
    p ->> 'reason', 'swap');
end $$;

revoke all on function private.apply_lead_moves(jsonb, text, text) from public, anon, authenticated;
revoke all on function public.move_leads(jsonb), public.swap_leads(jsonb) from public, anon;
grant execute on function public.move_leads(jsonb), public.swap_leads(jsonb) to authenticated;
