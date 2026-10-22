-- ===== Scheduler lock fix · 22 Oct 2026 =====
-- The 2-minute tick used a session advisory lock. Through Supabase's transaction pooler that lock
-- stays on a pooled server connection when an app instance is stopped mid-run (for example during
-- a deploy), and every later tick then skips. A lease row replaces it: it expires by itself.

create table if not exists private.tick_lease (
  id integer primary key default 1 check (id = 1),
  holder text,
  held_until timestamptz
);
insert into private.tick_lease (id) values (1) on conflict (id) do nothing;

-- Takes the lease when it is free or expired. Returns whether this run may go ahead.
create or replace function private.try_start_tick(p_holder text, p_seconds integer default 360)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update private.tick_lease
     set holder = p_holder, held_until = now() + make_interval(secs => p_seconds)
   where id = 1 and (held_until is null or held_until < now());
  return found;
end $$;

create or replace function private.end_tick(p_holder text)
returns void language sql security definer set search_path = '' as $$
  update private.tick_lease set holder = null, held_until = null where id = 1 and holder = p_holder
$$;

revoke all on table private.tick_lease from public, anon, authenticated;
revoke all on function private.try_start_tick(text, integer) from public, anon, authenticated;
revoke all on function private.end_tick(text) from public, anon, authenticated;
