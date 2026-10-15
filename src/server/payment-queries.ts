import "server-only";
import type postgres from "postgres";
import type { CustomerRow, PaymentQueueRow, PaymentsPage, SupportWork } from "@/domain/dto";
import type { Staff } from "./auth";
import { asUser, type Tx } from "./db";
import { mapOnboarding, mapPayment, mapSupportFollowUp } from "./mappers";

/** Reads for payments and support screens. All run as the signed-in user, so RLS decides what is visible. */

type Row = Record<string, unknown>;
type Frag = postgres.Fragment;

const TOTALS = (tx: Tx) => tx`
  coalesce((select sum(x.amount) from public.payments x where x.enrollment_id = e.id and x.status = 'confirmed'), 0) as paid,
  coalesce((select sum(x.amount) from public.payments x where x.enrollment_id = e.id and x.status = 'pending'), 0) as pending`;

function totals(r: Row) {
  const agreed = Number(r.agreed_total);
  const paid = Number(r.paid);
  return { agreed, paid, pending: Number(r.pending), balance: Math.max(agreed - paid, 0) };
}

// ── Payments queue (managers) ────────────────────────────────────────────

export type PaymentTab = "pending" | "confirmed" | "closed";

export async function paymentsPage(staff: Staff, tab: PaymentTab): Promise<PaymentsPage> {
  return asUser(staff.id, async (tx) => {
    const status = tab === "pending" ? tx`p.status = 'pending'` : tab === "confirmed" ? tx`p.status = 'confirmed'` : tx`p.status in ('rejected', 'reversed')`;
    const order = tab === "pending" ? tx`p.submitted_at asc` : tx`coalesce(p.reversed_at, p.decided_at) desc`;
    const [rows, [counts], month, flagged] = await Promise.all([
      tx<Row[]>`
        select p.*, e.inquiry_id, e.course_id, e.currency, e.agreed_total, i.program_id, i.sales_owner_id, c.name as customer_name, ${TOTALS(tx)}
        from public.payments p
        join public.enrollments e on e.id = p.enrollment_id
        join public.inquiries i on i.id = e.inquiry_id
        join public.contacts c on c.id = i.contact_id
        where ${status}
        order by ${order}
        limit 200`,
      tx<Row[]>`
        select (select count(*) from public.payments where status = 'pending') as pending,
               (select count(*) from public.payments where status = 'confirmed'
                  and (decided_at at time zone 'Africa/Cairo')::date = (now() at time zone 'Africa/Cairo')::date) as confirmed_today`,
      tx<Row[]>`
        select e.currency, sum(p.amount) as amount
        from public.payments p join public.enrollments e on e.id = p.enrollment_id
        where p.status = 'confirmed'
          and date_trunc('month', p.decided_at at time zone 'Africa/Cairo') = date_trunc('month', now() at time zone 'Africa/Cairo')
        group by e.currency order by e.currency`,
      customerRows(tx, tx`o.flagged_reason is not null`, tx`o.created_at`),
    ]);
    return {
      rows: rows.map((r): PaymentQueueRow => ({
        payment: mapPayment(r),
        inquiryId: String(r.inquiry_id),
        customerName: String(r.customer_name),
        programId: String(r.program_id),
        courseId: String(r.course_id),
        currency: String(r.currency),
        salesOwnerId: r.sales_owner_id ? String(r.sales_owner_id) : null,
        totals: totals(r),
      })),
      counts: {
        pending: Number(counts.pending),
        confirmedToday: Number(counts.confirmed_today),
        confirmedThisMonth: month.map((m) => ({ currency: String(m.currency), amount: Number(m.amount) })),
      },
      flagged,
    };
  });
}

// ── Customers (support and managers) ─────────────────────────────────────

async function customerRows(tx: Tx, where: Frag, order: Frag, limit = 300): Promise<CustomerRow[]> {
  const rows = await tx<Row[]>`
    select o.*, e.inquiry_id, e.course_id, e.currency, e.agreed_total, i.program_id, i.sales_owner_id, i.student_name,
           c.name as customer_name, c.phone_normalized, ${TOTALS(tx)},
           nd.label as next_label, nd.due_at as next_due, nd.kind as next_kind,
           coalesce((select json_agg(json_build_object('template_item_id', it.template_item_id, 'label', it.label, 'due_at', it.due_at,
                       'done_at', it.done_at, 'done_by', it.done_by) order by it.sort)
                     from public.onboarding_items it where it.onboarding_id = o.id), '[]') as items
    from public.onboardings o
    join public.enrollments e on e.id = o.enrollment_id
    join public.inquiries i on i.id = e.inquiry_id
    join public.contacts c on c.id = i.contact_id
    left join lateral (
      select * from (
        select it.label, it.due_at, 'checklist' as kind from public.onboarding_items it
        where it.onboarding_id = o.id and it.done_at is null and it.due_at is not null
        union all
        select f.note, f.due_at, 'follow_up' from public.support_follow_ups f where f.onboarding_id = o.id and f.status = 'open'
      ) d order by d.due_at limit 1
    ) nd on true
    where ${where}
    order by ${order}
    limit ${limit}`;
  return rows.map((r) => ({
    onboarding: mapOnboarding(r, r.items as Row[]),
    inquiryId: String(r.inquiry_id),
    customerName: String(r.customer_name),
    phone: String(r.phone_normalized),
    studentName: (r.student_name as string | null) ?? undefined,
    programId: String(r.program_id),
    courseId: String(r.course_id),
    salesOwnerId: r.sales_owner_id ? String(r.sales_owner_id) : null,
    totals: totals(r),
    currency: String(r.currency),
    nextDue: r.next_due ? { label: String(r.next_label), dueAt: new Date(r.next_due as string).toISOString(), kind: r.next_kind as "checklist" | "follow_up" } : undefined,
  }));
}

export interface CustomerFilters {
  status: "any" | "new_customer" | "onboarding" | "active";
  owner: "any" | "unclaimed" | "mine" | string;
  flaggedOnly: boolean;
  search: string;
}

export async function listCustomers(staff: Staff, f: CustomerFilters): Promise<CustomerRow[]> {
  return asUser(staff.id, async (tx) => {
    const parts: Frag[] = [tx`true`];
    if (f.status !== "any") parts.push(tx`o.status = ${f.status}::public.support_status`);
    if (f.owner === "unclaimed") parts.push(tx`o.support_owner_id is null`);
    else if (f.owner === "mine") parts.push(tx`o.support_owner_id = ${staff.id}`);
    else if (f.owner !== "any") parts.push(tx`o.support_owner_id = ${f.owner}`);
    if (f.flaggedOnly) parts.push(tx`o.flagged_reason is not null`);
    if (f.search.trim()) {
      const like = `%${f.search.trim().replace(/[\\%_]/g, (m) => "\\" + m)}%`;
      const digits = f.search.replace(/\D/g, "");
      parts.push(tx`(c.name ilike ${like} or coalesce(i.student_name, '') ilike ${like} ${digits.length >= 3 ? tx`or c.phone_normalized like ${"%" + digits.replace(/^0/, "") + "%"}` : tx``})`);
    }
    const where = parts.reduce((a, b) => tx`${a} and ${b}`);
    return customerRows(tx, where, tx`(o.flagged_reason is not null) desc, o.status, o.created_at desc`);
  });
}

// ── Support My Work ──────────────────────────────────────────────────────

export async function supportWork(staff: Staff): Promise<SupportWork> {
  return asUser(staff.id, async (tx) => {
    const [queue, mine, fus, overdue] = await Promise.all([
      customerRows(tx, tx`o.support_owner_id is null`, tx`o.created_at asc`, 100),
      customerRows(tx, tx`o.support_owner_id = ${staff.id} and o.status <> 'active'`, tx`(o.flagged_reason is not null) desc, o.created_at asc`, 100),
      tx<Row[]>`
        select f.*, c.name as customer_name, e.inquiry_id
        from public.support_follow_ups f
        join public.onboardings o on o.id = f.onboarding_id
        join public.enrollments e on e.id = o.enrollment_id
        join public.inquiries i on i.id = e.inquiry_id
        join public.contacts c on c.id = i.contact_id
        where f.status = 'open' and f.owner_id = ${staff.id}
          and (f.due_at at time zone 'Africa/Cairo')::date <= (now() at time zone 'Africa/Cairo')::date
        order by f.due_at`,
      tx<Row[]>`
        select it.label, it.due_at, it.onboarding_id, e.inquiry_id, c.name as customer_name
        from public.onboarding_items it
        join public.onboardings o on o.id = it.onboarding_id
        join public.enrollments e on e.id = o.enrollment_id
        join public.inquiries i on i.id = e.inquiry_id
        join public.contacts c on c.id = i.contact_id
        where o.support_owner_id = ${staff.id} and it.done_at is null and it.due_at < now()
        order by it.due_at`,
    ]);
    return {
      queue,
      mine,
      followUps: fus.map((f) => ({ ...mapSupportFollowUp(f), customerName: String(f.customer_name), inquiryId: String(f.inquiry_id) })),
      overdueItems: overdue.map((o) => ({
        inquiryId: String(o.inquiry_id), customerName: String(o.customer_name), label: String(o.label),
        dueAt: new Date(o.due_at as string).toISOString(), onboardingId: String(o.onboarding_id),
      })),
    };
  });
}
