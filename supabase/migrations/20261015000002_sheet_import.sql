-- Ammar Academy CRM · Phase 3 · Google Sheets import and Needs Review
--
-- How it fits together:
--   * google_accounts holds the Google sign-in a manager connected. The
--     refresh token is encrypted by the app (AES-256-GCM) before it is stored,
--     and staff accounts cannot read that column at all.
--   * sheet_connections is one tab of one spreadsheet, with its column mapping.
--   * sheet_rows is the ledger of every row ever seen, keyed by a stable row
--     identity (never the row number). Its primary key is what makes imports
--     safe to rerun and safe when two runs overlap.
--   * review_items holds rows that could not be imported automatically.
-- The sync engine (src/server/sheets) calls the private functions as the
-- system; managers use the public functions.

-- ── Tables ───────────────────────────────────────────────────────────────

create table public.google_accounts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  refresh_token_enc text,                 -- encrypted by the app; null after disconnect
  scopes text not null default '',
  status text not null default 'connected' check (status in ('connected', 'reconnect', 'disconnected')),
  last_error text,
  connected_by uuid references public.profiles (id),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.sheet_connections (
  id uuid primary key default gen_random_uuid(),
  google_account_id uuid not null references public.google_accounts (id),
  spreadsheet_id text not null check (spreadsheet_id ~ '^[A-Za-z0-9_-]{10,100}$'),
  spreadsheet_name text not null,
  sheet_title text not null,
  sheet_gid bigint not null,
  program_id uuid not null references public.programs (id),   -- used when the row has no program column
  header_row integer not null default 1 check (header_row between 1 and 20),
  headers text[] not null,
  -- [{"column": 0, "header": "Full name", "target": "name"}, …]; target "" = ignored
  mapping jsonb not null check (jsonb_typeof(mapping) = 'array'),
  identity text not null check (identity in ('lead_id', 'timestamp_phone', 'phone_program')),
  import_mode text not null check (import_mode in ('all', 'new_only')),
  enabled boolean not null default true,
  status text not null default 'active' check (status in ('active', 'paused', 'needs_attention', 'reconnect', 'unavailable')),
  status_message text,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_run jsonb,                          -- {"imported":n,"resubmitted":n,"review":n,"at":…}
  rows_imported integer not null default 0,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (spreadsheet_id, sheet_gid)
);

create table public.review_items (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid references public.sheet_connections (id) on delete set null,
  row_key text not null,
  row_number integer,
  kind text not null default 'invalid_row' check (kind in ('invalid_row')),
  problems text[] not null,
  raw jsonb not null,                      -- {"<header>": "<cell text>"} as it appeared in the sheet
  parsed jsonb not null default '{}'::jsonb, -- best-effort values to pre-fill the fix form
  status text not null default 'open' check (status in ('open', 'imported', 'dismissed')),
  resolution_note text,
  resolved_by uuid references public.profiles (id),
  resolved_at timestamptz,
  inquiry_id uuid references public.inquiries (id),
  created_at timestamptz not null default now()
);
create index review_items_open_idx on public.review_items (created_at) where status = 'open';

create table public.sheet_rows (
  connection_id uuid not null references public.sheet_connections (id) on delete cascade,
  row_key text not null,
  row_number integer,
  outcome text not null check (outcome in ('pending', 'imported', 'resubmitted', 'review', 'baseline', 'dismissed')),
  inquiry_id uuid references public.inquiries (id),
  review_item_id uuid references public.review_items (id),
  seen_at timestamptz not null default now(),
  primary key (connection_id, row_key)
);

alter table public.inquiries
  add constraint inquiries_source_connection_fk foreign key (source_connection_id)
  references public.sheet_connections (id) on delete set null;

-- ── Security ─────────────────────────────────────────────────────────────

alter table public.google_accounts enable row level security;
alter table public.sheet_connections enable row level security;
alter table public.sheet_rows enable row level security;
alter table public.review_items enable row level security;

-- New tables inherit Supabase's broad default grants; start from nothing, then grant reads only.
revoke all on public.google_accounts, public.sheet_connections, public.sheet_rows, public.review_items from anon, authenticated;
-- The token column is deliberately left out of the grant.
grant select (id, email, scopes, status, last_error, connected_by, connected_at, updated_at) on public.google_accounts to authenticated;
grant select on public.sheet_connections, public.sheet_rows, public.review_items to authenticated;

create policy google_accounts_read on public.google_accounts for select to authenticated using (private.is_manager());
create policy sheet_connections_read on public.sheet_connections for select to authenticated using (private.is_manager());
create policy sheet_rows_read on public.sheet_rows for select to authenticated using (private.is_manager());
create policy review_items_read on public.review_items for select to authenticated using (private.is_manager());

-- ── Core import (system) ─────────────────────────────────────────────────

-- Creates an inquiry from an already validated row and assigns it.
-- p: name, phone, phone_normalized, program_id, student_name, contact_type,
--    submitted_at (ISO, optional), custom {field_id: canonical value}, notes [text]
-- Returns {"outcome": "imported"|"resubmitted", "inquiry_id": …}
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

  insert into public.contacts (name, phone, phone_normalized, phone_secondary, phone_secondary_normalized, contact_type, created_by)
  values (left(trim(p ->> 'name'), 120), trim(p ->> 'phone'), p ->> 'phone_normalized',
          nullif(trim(p ->> 'phone_secondary'), ''), nullif(p ->> 'phone_secondary_normalized', ''),
          coalesce(nullif(p ->> 'contact_type', '')::public.contact_type, 'student'), p_actor)
  on conflict (phone_normalized) do nothing
  returning id into v_contact;
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

-- One sheet row. Claims the row in the ledger first: if another run already has it, nothing happens.
create or replace function private.import_sheet_row(p_connection uuid, p_row_key text, p_row_number integer, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_claimed text;
  r jsonb;
begin
  insert into public.sheet_rows (connection_id, row_key, row_number, outcome)
  values (p_connection, p_row_key, p_row_number, 'pending')
  on conflict do nothing
  returning row_key into v_claimed;
  if v_claimed is null then return jsonb_build_object('outcome', 'already'); end if;

  r := private.create_imported_inquiry(p, p_connection, p_row_number, null);
  update public.sheet_rows set outcome = r ->> 'outcome', inquiry_id = (r ->> 'inquiry_id')::uuid
  where connection_id = p_connection and row_key = p_row_key;
  update public.sheet_connections set rows_imported = rows_imported + case when r ->> 'outcome' = 'imported' then 1 else 0 end
  where id = p_connection;
  return r;
end $$;

-- A row that needs a person: recorded once, shown in Needs Review.
create or replace function private.flag_sheet_row(p_connection uuid, p_row_key text, p_row_number integer,
                                                  p_problems text[], p_raw jsonb, p_parsed jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_claimed text;
  v_item uuid;
begin
  insert into public.sheet_rows (connection_id, row_key, row_number, outcome)
  values (p_connection, p_row_key, p_row_number, 'review')
  on conflict do nothing
  returning row_key into v_claimed;
  if v_claimed is null then return jsonb_build_object('outcome', 'already'); end if;
  insert into public.review_items (connection_id, row_key, row_number, problems, raw, parsed)
  values (p_connection, p_row_key, p_row_number, p_problems, p_raw, coalesce(p_parsed, '{}'::jsonb))
  returning id into v_item;
  update public.sheet_rows set review_item_id = v_item where connection_id = p_connection and row_key = p_row_key;
  return jsonb_build_object('outcome', 'review', 'review_item_id', v_item);
end $$;

-- Result of one sync of one connection. Managers are told when a connection starts needing attention.
create or replace function private.record_sync(p_connection uuid, p_status text, p_message text, p_run jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c public.sheet_connections;
begin
  select * into c from public.sheet_connections where id = p_connection for update;
  if not found then return; end if;
  update public.sheet_connections set
    status = case when c.status = 'paused' then 'paused' else p_status end,
    status_message = p_message,
    last_checked_at = now(),
    last_success_at = case when p_status = 'active' then now() else last_success_at end,
    last_run = coalesce(p_run, last_run),
    updated_at = now()
  where id = p_connection;
  if p_status <> 'active' and c.status = 'active' then
    insert into public.notifications (user_id, text)
    select id, format('Google Sheet "%s" needs attention: %s', c.spreadsheet_name, p_message)
    from public.profiles where role = 'manager' and active;
  end if;
end $$;

-- Saved by the server after Google sign-in. Reconnecting the same account replaces the token
-- and puts its connections back to work.
create or replace function private.save_google_account(p_email text, p_token_enc text, p_scopes text, p_user uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.google_accounts (email, refresh_token_enc, scopes, status, last_error, connected_by, connected_at, updated_at)
  values (lower(p_email), p_token_enc, p_scopes, 'connected', null, p_user, now(), now())
  on conflict (email) do update set refresh_token_enc = coalesce(excluded.refresh_token_enc, public.google_accounts.refresh_token_enc),
    scopes = excluded.scopes, status = 'connected', last_error = null, connected_by = excluded.connected_by,
    connected_at = now(), updated_at = now()
  returning id into v_id;
  update public.sheet_connections set status = 'active', status_message = null
  where google_account_id = v_id and status = 'reconnect';
  insert into public.audit_log (actor_id, action, target) values (p_user, 'Connected Google account', lower(p_email));
  return v_id;
end $$;

-- Google refused the stored sign-in (revoked, password changed, expired).
create or replace function private.mark_google_reconnect(p_account uuid, p_message text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_was text;
begin
  select status into v_was from public.google_accounts where id = p_account for update;
  update public.google_accounts set status = 'reconnect', last_error = p_message, updated_at = now() where id = p_account;
  update public.sheet_connections set status = 'reconnect', status_message = p_message, last_checked_at = now()
  where google_account_id = p_account and status <> 'paused';
  if v_was = 'connected' then
    insert into public.notifications (user_id, text)
    select id, 'Google Sheets stopped syncing: the Google sign-in needs to be reconnected (Settings → Google Sheets Connections).'
    from public.profiles where role = 'manager' and active;
  end if;
end $$;

revoke all on function private.create_imported_inquiry(jsonb, uuid, integer, uuid), private.import_sheet_row(uuid, text, integer, jsonb),
  private.flag_sheet_row(uuid, text, integer, text[], jsonb, jsonb), private.record_sync(uuid, text, text, jsonb),
  private.save_google_account(text, text, text, uuid), private.mark_google_reconnect(uuid, text)
  from public, anon, authenticated;

-- ── Manager functions ────────────────────────────────────────────────────

-- Creates or updates a connection.
-- p: id?, google_account_id, spreadsheet_id, spreadsheet_name, sheet_title, sheet_gid, program_id,
--    header_row, headers [text], mapping [{column, header, target}], identity, import_mode,
--    baseline [{key, row}] (rows that already existed, when import_mode = new_only; create only)
create or replace function public.save_sheet_connection(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_targets text[];
  v_name text := trim(coalesce(p ->> 'spreadsheet_name', ''));
begin
  perform private.require_role('manager');
  if not exists (select 1 from public.google_accounts where id = (p ->> 'google_account_id')::uuid and status = 'connected') then
    perform private.fail('Connect a Google account first.');
  end if;
  if not exists (select 1 from public.programs where id = (p ->> 'program_id')::uuid and active) then
    perform private.fail('Choose the program for this sheet.');
  end if;
  if jsonb_typeof(p -> 'mapping') <> 'array' then perform private.fail('Map the sheet columns.'); end if;
  select coalesce(array_agg(m ->> 'target'), '{}') into v_targets
  from jsonb_array_elements(p -> 'mapping') m where coalesce(m ->> 'target', '') <> '';
  if not ('name' = any (v_targets)) then perform private.fail('Choose the column that holds the name.'); end if;
  if not ('phone' = any (v_targets)) then perform private.fail('Choose the column that holds the phone number.'); end if;
  -- Several columns may go to the timeline as a note; every other CRM field takes one column.
  if (select count(*) from unnest(v_targets) t where t <> 'note' group by t order by count(*) desc limit 1) > 1 then
    perform private.fail('Each CRM field can be matched to one column only.');
  end if;
  if p ->> 'identity' = 'lead_id' and not ('lead_id' = any (v_targets)) then
    perform private.fail('Choose the lead ID column, or let the CRM identify rows by time and phone.');
  end if;
  if p ->> 'identity' = 'timestamp_phone' and not ('submitted_at' = any (v_targets)) then
    perform private.fail('Choose the timestamp column, or identify rows another way.');
  end if;

  if v_id is null then
    if exists (select 1 from public.sheet_connections where spreadsheet_id = p ->> 'spreadsheet_id' and sheet_gid = (p ->> 'sheet_gid')::bigint) then
      perform private.fail('This tab is already connected. Edit the existing connection instead.');
    end if;
    insert into public.sheet_connections (google_account_id, spreadsheet_id, spreadsheet_name, sheet_title, sheet_gid, program_id,
      header_row, headers, mapping, identity, import_mode, created_by)
    values ((p ->> 'google_account_id')::uuid, p ->> 'spreadsheet_id', v_name, p ->> 'sheet_title', (p ->> 'sheet_gid')::bigint,
      (p ->> 'program_id')::uuid, coalesce((p ->> 'header_row')::integer, 1),
      array(select jsonb_array_elements_text(p -> 'headers')), p -> 'mapping', p ->> 'identity', p ->> 'import_mode', auth.uid())
    returning id into v_id;
    if p ->> 'import_mode' = 'new_only' and jsonb_typeof(p -> 'baseline') = 'array' then
      insert into public.sheet_rows (connection_id, row_key, row_number, outcome)
      select v_id, b ->> 'key', (b ->> 'row')::integer, 'baseline' from jsonb_array_elements(p -> 'baseline') b
      on conflict do nothing;
    end if;
    perform private.audit('Connected Google Sheet', v_name || ' · ' || (p ->> 'sheet_title'));
  else
    update public.sheet_connections set
      program_id = (p ->> 'program_id')::uuid,
      header_row = coalesce((p ->> 'header_row')::integer, header_row),
      headers = array(select jsonb_array_elements_text(p -> 'headers')),
      mapping = p -> 'mapping',
      identity = p ->> 'identity',
      status = case when status in ('needs_attention') then 'active' else status end,
      status_message = case when status in ('needs_attention') then null else status_message end,
      updated_at = now(), version = version + 1
    where id = v_id;
    if not found then raise exception using errcode = 'CRM04', message = 'Connection not found.'; end if;
    perform private.audit('Updated Google Sheet mapping', v_name);
  end if;
  return v_id;
end $$;

create or replace function public.set_sheet_connection_paused(p_id uuid, p_paused boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  perform private.require_role('manager');
  update public.sheet_connections
     set status = case when p_paused then 'paused' else 'active' end, enabled = not p_paused,
         status_message = null, updated_at = now()
   where id = p_id returning spreadsheet_name into v_name;
  if v_name is null then raise exception using errcode = 'CRM04', message = 'Connection not found.'; end if;
  perform private.audit(case when p_paused then 'Paused Google Sheet sync' else 'Resumed Google Sheet sync' end, v_name);
end $$;

-- Stops syncing and forgets the row ledger. Leads already imported stay exactly as they are.
create or replace function public.delete_sheet_connection(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  perform private.require_role('manager');
  update public.review_items set status = 'dismissed', resolution_note = 'Connection removed', resolved_by = auth.uid(), resolved_at = now()
  where connection_id = p_id and status = 'open';
  delete from public.sheet_connections where id = p_id returning spreadsheet_name into v_name;
  if v_name is null then raise exception using errcode = 'CRM04', message = 'Connection not found.'; end if;
  perform private.audit('Removed Google Sheet connection', v_name);
end $$;

-- Forgets the stored Google sign-in. Connections using it stop until it is connected again.
create or replace function public.disconnect_google_account(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_email text;
begin
  perform private.require_role('manager');
  update public.google_accounts set refresh_token_enc = null, status = 'disconnected', updated_at = now()
  where id = p_id returning email into v_email;
  if v_email is null then raise exception using errcode = 'CRM04', message = 'Account not found.'; end if;
  update public.sheet_connections set status = 'reconnect', status_message = 'Google account disconnected'
  where google_account_id = p_id and status <> 'paused';
  perform private.audit('Disconnected Google account', v_email);
end $$;

-- Needs Review → "Import" with corrected values (same payload as create_imported_inquiry).
create or replace function public.resolve_review_import(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  it public.review_items;
  r jsonb;
begin
  perform private.require_role('manager');
  select * into it from public.review_items where id = p_id for update;
  if not found then raise exception using errcode = 'CRM04', message = 'This review item no longer exists.'; end if;
  if it.status <> 'open' then perform private.fail('This row was already handled.'); end if;
  r := private.create_imported_inquiry(p, it.connection_id, it.row_number, auth.uid());
  update public.review_items set status = 'imported', resolved_by = auth.uid(), resolved_at = now(),
    inquiry_id = (r ->> 'inquiry_id')::uuid, resolution_note = r ->> 'outcome'
  where id = p_id;
  update public.sheet_rows set outcome = r ->> 'outcome', inquiry_id = (r ->> 'inquiry_id')::uuid
  where review_item_id = p_id;
  perform private.audit('Imported reviewed row', trim(p ->> 'name'));
  return r;
end $$;

create or replace function public.dismiss_review(p_id uuid, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare it public.review_items;
begin
  perform private.require_role('manager');
  if coalesce(trim(p_note), '') = '' then perform private.fail('Add a short reason (for example: test entry, spam).'); end if;
  select * into it from public.review_items where id = p_id for update;
  if not found then raise exception using errcode = 'CRM04', message = 'This review item no longer exists.'; end if;
  if it.status <> 'open' then perform private.fail('This row was already handled.'); end if;
  update public.review_items set status = 'dismissed', resolved_by = auth.uid(), resolved_at = now(), resolution_note = trim(p_note)
  where id = p_id;
  update public.sheet_rows set outcome = 'dismissed' where review_item_id = p_id;
  perform private.audit('Dismissed review row (' || trim(p_note) || ')', 'Sheet row ' || coalesce(it.row_number::text, '?'));
end $$;

grant execute on function public.save_sheet_connection(jsonb), public.set_sheet_connection_paused(uuid, boolean),
  public.delete_sheet_connection(uuid), public.disconnect_google_account(uuid), public.resolve_review_import(uuid, jsonb),
  public.dismiss_review(uuid, text) to authenticated;
revoke execute on function public.save_sheet_connection(jsonb), public.set_sheet_connection_paused(uuid, boolean),
  public.delete_sheet_connection(uuid), public.disconnect_google_account(uuid), public.resolve_review_import(uuid, jsonb),
  public.dismiss_review(uuid, text) from public, anon;
