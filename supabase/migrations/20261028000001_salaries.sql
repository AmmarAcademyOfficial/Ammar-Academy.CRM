-- ===== Accounting plan · Phase 5 · 22 Oct 2026 =====
-- Teacher salaries per Academy month (26th to 25th, named after the month it ends in).
--   * Pay = the paid hours of every recorded session in the month × the rate's amount on that
--     session's day (a mid-month rate change gives two lines). Group sessions are paid once.
--   * salary_adjustments: manual bonus / deduction lines, per teacher and currency.
--   * Closing a month (managers) freezes its lines in salary_lines; sessions in a closed month can
--     no longer change. Reopening (managers, with a reason) unfreezes it.
--   * EGP and USD are kept apart; totals are per currency, never summed together.
-- Who: managers and accountants see salaries and add adjustments; only managers close and reopen.
-- Additive: new tables, functions and one trigger on teacher_sessions.

create table if not exists public.salary_months (
  month date primary key check (extract(day from month) = 1),   -- first day of the month it ends in
  status text not null default 'open' check (status in ('open', 'closed')),
  closed_by uuid references public.profiles (id),
  closed_at timestamptz,
  reopen_reason text check (reopen_reason is null or length(reopen_reason) <= 300),
  updated_at timestamptz not null default now()
);

create table if not exists public.salary_lines (
  id uuid primary key default gen_random_uuid(),
  month date not null references public.salary_months (month) on delete cascade,
  teacher_id uuid not null references public.teachers (id),
  rate_id uuid not null references public.teacher_rates (id),
  rate_name text not null,
  currency text not null,
  per_hour numeric(10, 2) not null,
  hours numeric(8, 2) not null,
  sessions integer not null,
  amount numeric(12, 2) not null
);
create index if not exists salary_lines_month_idx on public.salary_lines (month);

create table if not exists public.salary_adjustments (
  id uuid primary key default gen_random_uuid(),
  month date not null check (extract(day from month) = 1),
  teacher_id uuid not null references public.teachers (id),
  kind text not null check (kind in ('bonus', 'deduction')),
  amount numeric(10, 2) not null check (amount > 0 and amount <= 1000000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  note text not null check (length(trim(note)) between 1 and 300),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists salary_adjustments_month_idx on public.salary_adjustments (month);

alter table public.salary_months enable row level security;
alter table public.salary_lines enable row level security;
alter table public.salary_adjustments enable row level security;
revoke all on public.salary_months, public.salary_lines, public.salary_adjustments from anon, authenticated;
grant select on public.salary_months, public.salary_lines, public.salary_adjustments to authenticated;
drop policy if exists finance_read on public.salary_months;
create policy finance_read on public.salary_months for select to authenticated using ((select private.my_role()) in ('manager', 'accountant'));
drop policy if exists finance_read on public.salary_lines;
create policy finance_read on public.salary_lines for select to authenticated using ((select private.my_role()) in ('manager', 'accountant'));
drop policy if exists finance_read on public.salary_adjustments;
create policy finance_read on public.salary_adjustments for select to authenticated using ((select private.my_role()) in ('manager', 'accountant'));

-- ── Month helpers ────────────────────────────────────────────────────────
-- 'YYYY-MM' (the month it ends in) → the first day of that month.
create or replace function private.salary_month_key(p_month text) returns date
language plpgsql immutable set search_path = '' as $$
begin
  if p_month is null or p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then perform private.fail('Choose a month.'); end if;
  return (p_month || '-01')::date;
end $$;

-- The Academy month a day belongs to (26th onwards counts towards the next month).
create or replace function private.salary_month_of(p_day date) returns date
language sql immutable set search_path = '' as $$
  select case when extract(day from p_day) >= 26 then (date_trunc('month', p_day) + interval '1 month')::date
              else date_trunc('month', p_day)::date end
$$;

create or replace function private.salary_from(p_key date) returns date
language sql immutable set search_path = '' as $$ select ((p_key - interval '1 month') + interval '25 days')::date $$;
create or replace function private.salary_to(p_key date) returns date
language sql immutable set search_path = '' as $$ select (p_key + interval '24 days')::date $$;

create or replace function private.salary_closed(p_key date) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.salary_months m where m.month = p_key and m.status = 'closed')
$$;

-- Lines worked out from the sessions: one per teacher, rate and amount per hour.
create or replace function private.salary_live_lines(p_key date)
returns table (teacher_id uuid, rate_id uuid, rate_name text, currency text, per_hour numeric, hours numeric, sessions integer, amount numeric)
language sql stable security definer set search_path = '' as $$
  with s as (
    select ts.teacher_id, ts.rate_id, ts.paid_hours,
           private.rate_amount_on(ts.rate_id, (ts.starts_at at time zone 'Africa/Cairo')::date) as per_hour
      from public.teacher_sessions ts
     where ts.status <> 'scheduled' and ts.paid_hours > 0
       and (ts.starts_at at time zone 'Africa/Cairo')::date between private.salary_from(p_key) and private.salary_to(p_key)
  )
  select s.teacher_id, s.rate_id, r.name, r.currency, s.per_hour, sum(s.paid_hours), count(*)::integer,
         round(sum(s.paid_hours * s.per_hour), 2)
    from s join public.teacher_rates r on r.id = s.rate_id
   group by s.teacher_id, s.rate_id, r.name, r.currency, s.per_hour
$$;

-- ── The report (managers and accountants) ────────────────────────────────
create or replace function public.salary_report(p_month text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_key date := private.salary_month_key(p_month);
  m public.salary_months;
  v_closed boolean;
  v_lines jsonb;
  v_result jsonb;
begin
  perform private.require_finance();
  select * into m from public.salary_months where month = v_key;
  v_closed := coalesce(m.status = 'closed', false);

  with lines as (
    select l.teacher_id, l.rate_id, l.rate_name, l.currency, l.per_hour, l.hours, l.sessions, l.amount
      from public.salary_lines l where v_closed and l.month = v_key
    union all
    select x.* from private.salary_live_lines(v_key) x where not v_closed
  ),
  adj as (select * from public.salary_adjustments a where a.month = v_key),
  signed as (
    select teacher_id, currency, coalesce(amount, 0) as amount from lines
    union all select teacher_id, currency, case when kind = 'bonus' then amount else -amount end from adj
  ),
  people as (select teacher_id from lines union select teacher_id from adj)
  select coalesce(jsonb_agg(jsonb_build_object(
           'teacherId', t.id, 'name', t.full_name,
           'lines', coalesce((select jsonb_agg(jsonb_build_object('rateId', l.rate_id, 'rateName', l.rate_name, 'currency', l.currency,
                      'perHour', l.per_hour, 'hours', l.hours, 'sessions', l.sessions, 'amount', l.amount) order by l.rate_name, l.per_hour)
                    from lines l where l.teacher_id = t.id), '[]'),
           'adjustments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'amount', a.amount, 'currency', a.currency,
                      'note', a.note, 'createdBy', (select full_name from public.profiles where id = a.created_by), 'createdAt', a.created_at) order by a.created_at)
                    from adj a where a.teacher_id = t.id), '[]'),
           'totals', coalesce((select jsonb_object_agg(currency, total) from (select currency, sum(amount) as total from signed where teacher_id = t.id group by currency) z), '{}')
         ) order by t.full_name), '[]')
    into v_lines
    from people p join public.teachers t on t.id = p.teacher_id;

  v_result := jsonb_build_object(
    'month', p_month,
    'from', private.salary_from(v_key), 'to', private.salary_to(v_key),
    'status', case when v_closed then 'closed' else 'open' end,
    'closedAt', case when v_closed then m.closed_at end,
    'closedBy', case when v_closed then (select full_name from public.profiles where id = m.closed_by) end,
    'reopenReason', case when not v_closed then m.reopen_reason end,
    'teachers', v_lines,
    'totals', coalesce((select jsonb_object_agg(currency, total) from (
                 select currency, sum(amount) as total from (
                   select (l ->> 'currency') as currency, (l ->> 'amount')::numeric as amount from jsonb_array_elements(v_lines) t, jsonb_array_elements(t -> 'lines') l
                   union all
                   select (a ->> 'currency'), case when a ->> 'kind' = 'bonus' then 1 else -1 end * (a ->> 'amount')::numeric
                     from jsonb_array_elements(v_lines) t, jsonb_array_elements(t -> 'adjustments') a) u
                 group by currency) z), '{}'),
    'unrecorded', (select count(*) from public.teacher_sessions ts where ts.status = 'scheduled' and ts.starts_at < now()
                     and (ts.starts_at at time zone 'Africa/Cairo')::date between private.salary_from(v_key) and private.salary_to(v_key)),
    'missingRates', (select count(*) from jsonb_array_elements(v_lines) t, jsonb_array_elements(t -> 'lines') l where l ->> 'perHour' is null),
    'ended', (now() at time zone 'Africa/Cairo')::date > private.salary_to(v_key)
  );
  return v_result;
end $$;

-- ── Adjustments (managers and accountants, open months only) ─────────────
-- p: id?, month 'YYYY-MM', teacher_id, kind bonus|deduction, amount, currency, note
create or replace function public.save_salary_adjustment(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_key date := private.salary_month_key(p ->> 'month');
  v_teacher text;
  v_kind text := p ->> 'kind';
  v_amount numeric := nullif(p ->> 'amount', '')::numeric;
  v_cur text := upper(coalesce(nullif(trim(p ->> 'currency'), ''), 'EGP'));
  v_note text := trim(coalesce(p ->> 'note', ''));
  v_old date;
begin
  perform private.require_finance();
  if v_id is not null then
    select month into v_old from public.salary_adjustments where id = v_id;
    if not found then raise exception using errcode = 'CRM04', message = 'Adjustment not found.'; end if;
    if private.salary_closed(v_old) then perform private.fail('This month is closed. A manager can reopen it first.'); end if;
  end if;
  if private.salary_closed(v_key) then perform private.fail('This month is closed. A manager can reopen it first.'); end if;
  select full_name into v_teacher from public.teachers where id = nullif(p ->> 'teacher_id', '')::uuid;
  if v_teacher is null then perform private.fail('Choose a teacher.'); end if;
  if v_kind is null or v_kind not in ('bonus', 'deduction') then perform private.fail('Choose bonus or deduction.'); end if;
  if v_amount is null or v_amount <= 0 or v_amount > 1000000 then perform private.fail('Enter the amount.'); end if;
  if v_cur !~ '^[A-Z]{3}$' then perform private.fail('Choose the currency.'); end if;
  if v_note = '' then perform private.fail('Add a short reason, for example "Extra mock exam".'); end if;
  if length(v_note) > 300 then perform private.fail('The reason is too long (300 characters at most).'); end if;
  if v_id is null then
    insert into public.salary_adjustments (month, teacher_id, kind, amount, currency, note, created_by)
    values (v_key, (p ->> 'teacher_id')::uuid, v_kind, v_amount, v_cur, v_note, auth.uid()) returning id into v_id;
  else
    update public.salary_adjustments set month = v_key, teacher_id = (p ->> 'teacher_id')::uuid, kind = v_kind, amount = v_amount,
      currency = v_cur, note = v_note, updated_at = now() where id = v_id;
  end if;
  perform private.audit(format('Salary %s %s for %s: %s (%s)', v_kind, private.money(v_amount, v_cur), to_char(v_key, 'FMMonth YYYY'), v_note,
                               case when (p ->> 'id') is null then 'added' else 'changed' end), v_teacher);
  return v_id;
end $$;

create or replace function public.delete_salary_adjustment(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.salary_adjustments;
begin
  perform private.require_finance();
  select * into a from public.salary_adjustments where id = p_id;
  if not found then raise exception using errcode = 'CRM04', message = 'Adjustment not found.'; end if;
  if private.salary_closed(a.month) then perform private.fail('This month is closed. A manager can reopen it first.'); end if;
  delete from public.salary_adjustments where id = p_id;
  perform private.audit(format('Removed salary %s %s for %s: %s', a.kind, private.money(a.amount, a.currency), to_char(a.month, 'FMMonth YYYY'), a.note),
                        (select full_name from public.teachers where id = a.teacher_id));
end $$;

-- ── Close and reopen (managers) ──────────────────────────────────────────
create or replace function public.close_salary_month(p_month text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key date := private.salary_month_key(p_month);
  v_unrecorded integer;
  v_missing integer;
  v_lines integer;
begin
  perform private.require_role('manager');
  if private.salary_closed(v_key) then perform private.fail('This month is already closed.'); end if;
  if (now() at time zone 'Africa/Cairo')::date <= private.salary_to(v_key) then
    perform private.fail(format('This month runs until %s. Close it after that day.', to_char(private.salary_to(v_key), 'FMDD Mon YYYY')));
  end if;
  select count(*) into v_unrecorded from public.teacher_sessions ts
   where ts.status = 'scheduled'
     and (ts.starts_at at time zone 'Africa/Cairo')::date between private.salary_from(v_key) and private.salary_to(v_key);
  if v_unrecorded > 0 then
    perform private.fail(format('%s session%s in this month %s not recorded yet. Record or remove %s first (Sessions page).',
      v_unrecorded, case when v_unrecorded = 1 then '' else 's' end, case when v_unrecorded = 1 then 'is' else 'are' end,
      case when v_unrecorded = 1 then 'it' else 'them' end));
  end if;
  select count(*) into v_missing from private.salary_live_lines(v_key) x where x.per_hour is null;
  if v_missing > 0 then perform private.fail('Some sessions have no hourly amount for their date. Set the rate amount in Settings → Teachers first.'); end if;

  insert into public.salary_months (month, status, closed_by, closed_at, reopen_reason, updated_at)
  values (v_key, 'closed', auth.uid(), now(), null, now())
  on conflict (month) do update set status = 'closed', closed_by = auth.uid(), closed_at = now(), reopen_reason = null, updated_at = now();
  delete from public.salary_lines where month = v_key;
  insert into public.salary_lines (month, teacher_id, rate_id, rate_name, currency, per_hour, hours, sessions, amount)
  select v_key, x.teacher_id, x.rate_id, x.rate_name, x.currency, x.per_hour, x.hours, x.sessions, x.amount from private.salary_live_lines(v_key) x;
  get diagnostics v_lines = row_count;
  perform private.audit(format('Closed salaries for %s', to_char(v_key, 'FMMonth YYYY')), format('%s line%s', v_lines, case when v_lines = 1 then '' else 's' end));
  return public.salary_report(p_month);
end $$;

create or replace function public.reopen_salary_month(p_month text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_key date := private.salary_month_key(p_month);
  v_reason text := trim(coalesce(p_reason, ''));
begin
  perform private.require_role('manager');
  if not private.salary_closed(v_key) then perform private.fail('This month is not closed.'); end if;
  if v_reason = '' then perform private.fail('Add a short reason for reopening.'); end if;
  if length(v_reason) > 300 then perform private.fail('The reason is too long (300 characters at most).'); end if;
  update public.salary_months set status = 'open', reopen_reason = v_reason, updated_at = now() where month = v_key;
  delete from public.salary_lines where month = v_key;
  perform private.audit(format('Reopened salaries for %s', to_char(v_key, 'FMMonth YYYY')), v_reason);
end $$;

-- ── Sessions in a closed month cannot change ─────────────────────────────
create or replace function private.guard_closed_salary_month() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_day date;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_day := (old.starts_at at time zone 'Africa/Cairo')::date;
    if private.salary_closed(private.salary_month_of(v_day)) then
      perform private.fail(format('Salaries for %s are closed, so sessions on %s can no longer change. A manager can reopen the month in Accounting → Teachers.',
        to_char(private.salary_month_of(v_day), 'FMMonth YYYY'), to_char(v_day, 'FMDD Mon')));
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_day := (new.starts_at at time zone 'Africa/Cairo')::date;
    if private.salary_closed(private.salary_month_of(v_day)) then
      perform private.fail(format('Salaries for %s are closed, so sessions on %s can no longer change. A manager can reopen the month in Accounting → Teachers.',
        to_char(private.salary_month_of(v_day), 'FMMonth YYYY'), to_char(v_day, 'FMDD Mon')));
    end if;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists teacher_sessions_closed_month on public.teacher_sessions;
create trigger teacher_sessions_closed_month before insert or update or delete on public.teacher_sessions
  for each row execute function private.guard_closed_salary_month();

-- ── Grants ───────────────────────────────────────────────────────────────
revoke all on function public.salary_report(text), public.save_salary_adjustment(jsonb), public.delete_salary_adjustment(uuid),
  public.close_salary_month(text), public.reopen_salary_month(text, text) from public, anon;
grant execute on function public.salary_report(text), public.save_salary_adjustment(jsonb), public.delete_salary_adjustment(uuid),
  public.close_salary_month(text), public.reopen_salary_month(text, text) to authenticated;
revoke all on function private.salary_month_key(text), private.salary_month_of(date), private.salary_from(date), private.salary_to(date),
  private.salary_closed(date), private.salary_live_lines(date), private.guard_closed_salary_month() from public, anon, authenticated;
