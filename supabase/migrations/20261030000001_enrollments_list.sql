-- ===== CRM changes · Part B · 26 Oct 2026 =====
-- The Enrollments list: every enrolled customer (one row per enrollment) with filters that combine,
-- sorting, paging and totals per currency, for managers, accountants and support.
--   * Managers and accountants see every enrollment; accountants get no phone numbers.
--   * Support sees their own customers by default, or every customer with scope 'all' (to cover for a colleague).
--   * Sales agents cannot use it.
-- Read-only and additive: one new function; nothing existing changes.

create or replace function public.enrollments_list(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
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
begin
  if v_scope not in ('mine', 'all') then perform private.fail('Choose whose customers to show.'); end if;
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
           case when v_role = 'accountant' then null else c.phone_normalized end as phone,
           i.student_name, i.program_id, e.course_id, co.course_type_id, co.start_date as course_start,
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
           c.phone_normalized as search_phone, c.phone_secondary_normalized as search_phone2
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
     where (v_role <> 'support' or v_scope = 'all' or b.support_owner_id = v_me)
       and (v_search is null or b.customer_name ilike '%' || replace(replace(v_search, '%', '\%'), '_', '\_') || '%'
            or coalesce(b.student_name, '') ilike '%' || replace(replace(v_search, '%', '\%'), '_', '\_') || '%'
            or (v_role <> 'accountant' and v_digits is not null and length(v_digits) >= 3
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
    'page', v_page, 'pageSize', v_size, 'scope', v_scope,
    'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'count', n, 'agreed', agreed, 'paid', paid, 'balance', balance, 'overdue', overdue) order by n desc)
                          from (select currency, count(*) as n, sum(agreed) as agreed, sum(paid) as paid, sum(balance) as balance, sum(overdue_left) as overdue from hit group by currency) t), '[]'),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'enrollmentId', o.enrollment_id, 'inquiryId', o.inquiry_id, 'customerName', o.customer_name, 'phone', o.phone,
        'studentName', o.student_name, 'programId', o.program_id, 'courseId', o.course_id, 'courseTypeId', o.course_type_id,
        'courseStart', o.course_start, 'enrolledAt', o.enrolled_at, 'salesAgentId', o.sales_agent_id, 'supportOwnerId', o.support_owner_id,
        'status', o.status, 'currency', o.currency, 'agreed', o.agreed, 'paid', o.paid, 'pending', o.pending, 'balance', o.balance,
        'lastPaidOn', o.last_paid_on, 'nextDueOn', o.next_due_on, 'nextDueLeft', o.next_due_left, 'overdueLeft', o.overdue_left,
        'teacherIds', to_jsonb(o.teacher_ids), 'teacherNames', o.teacher_names, 'packageHours', o.package_hours, 'packageUsed', o.package_used) order by o.n)
      from ordered o where o.n > v_page * v_size and o.n <= (v_page + 1) * v_size), '[]')
  ) into v_result;
  return v_result;
end $$;

revoke all on function public.enrollments_list(jsonb) from public, anon;
grant execute on function public.enrollments_list(jsonb) to authenticated;
