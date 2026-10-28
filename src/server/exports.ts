import "server-only";
import type { z } from "zod";
import type { EnrollmentList, LeadQuery } from "@/domain/dto";
import type { LeadFilters } from "@/domain/types";
import { getStaff, type Staff } from "./auth";
import { asUser, type Tx } from "./db";
import type { enrollmentExportQuerySchema, enrollmentFiltersSchema } from "./enrollment-filter-schema";
import { filterSql } from "./queries";
import { toResult } from "./result";
import { buildXlsx, type Column, type Sheet } from "./xlsx";

/** The most rows one download holds (the plan: up to 20,000, built on the server). */
export const MAX_EXPORT_ROWS = 20_000;

type Row = Record<string, unknown>;
type EnrollmentFilters = z.infer<typeof enrollmentFiltersSchema>;
type EnrollmentExportQuery = z.infer<typeof enrollmentExportQuerySchema>;

const STATUS: Record<string, number> = { forbidden: 403, not_found: 404, conflict: 409, unauthenticated: 401, server: 500 };

/** Wraps a download route: requires a staff session; returns the file, or a JSON error like other routes. */
export async function exportRoute(fn: (staff: Staff) => Promise<{ file: Buffer; name: string }>): Promise<Response> {
  const staff = await getStaff();
  if (!staff) return Response.json({ error: "Sign in again." }, { status: 401 });
  try {
    const { file, name } = await fn(staff);
    return new Response(new Uint8Array(file), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    const r = toResult(e);
    if (r.ok) return Response.json({ error: "Error" }, { status: 500 });
    return Response.json({ error: r.error }, { status: STATUS[r.code ?? ""] ?? 400 });
  }
}

function cairoStamp(d = new Date()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}`;
}

function tooMany(n: number, what: string): never {
  throw Object.assign(new Error("Too many rows"), {
    code: "CRM01",
    message: `${n.toLocaleString("en-US")} ${what} match. A download holds up to ${MAX_EXPORT_ROWS.toLocaleString("en-US")}; narrow the filters and download in parts.`,
  });
}

// ── Describing the filters for the audit log ─────────────────────────────

/** Names for every id used in the filters (programs, courses, people, tags…), read as the user. */
async function namesFor(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  const uuids = [...new Set(ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x)))];
  if (!uuids.length) return new Map();
  const rows = await tx<{ id: string; name: string }[]>`
    select id::text, name from public.programs where id = any (${uuids}::uuid[])
    union all select id::text, name from public.courses where id = any (${uuids}::uuid[])
    union all select id::text, name from public.course_types where id = any (${uuids}::uuid[])
    union all select id::text, full_name from public.profiles where id = any (${uuids}::uuid[])
    union all select id::text, full_name from public.teachers where id = any (${uuids}::uuid[])
    union all select id::text, name from public.tags where id = any (${uuids}::uuid[])
    union all select id::text, label from public.contact_outcomes where id = any (${uuids}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r.name]));
}

const list = (names: Map<string, string>, ids: string[], special: Record<string, string> = {}) =>
  ids.map((id) => special[id] ?? names.get(id) ?? "?").join(", ");
const range = (label: string, from: string, to: string) =>
  from && to ? `${label} ${from} to ${to}` : from ? `${label} from ${from}` : to ? `${label} up to ${to}` : "";

export async function describeLeadFilters(tx: Tx, f: LeadFilters): Promise<string> {
  const names = await namesFor(tx, [...f.programIds, ...f.outcomeIds, ...f.tagIds, ...f.ownerIds, ...(f.courseIds ?? []), ...(f.courseTypeIds ?? [])]);
  const stages = f.stageKeys.length ? await tx<{ label: string }[]>`select label from public.stages where system_key::text = any (${f.stageKeys}::text[]) order by sort` : [];
  const parts = [
    f.search.trim() && `search "${f.search.trim()}"`,
    f.programIds.length && `program: ${list(names, f.programIds)}`,
    stages.length && `stage: ${stages.map((s) => s.label).join(", ")}`,
    f.outcomeIds.length && `last outcome: ${list(names, f.outcomeIds)}`,
    f.tagIds.length && `tags: ${list(names, f.tagIds)}`,
    f.primaryColors.length && `main tag colour: ${f.primaryColors.join(", ")}`,
    f.ownerIds.length && `sales agent: ${list(names, f.ownerIds, { unassigned: "Unassigned" })}`,
    f.courseIds?.length && `course: ${list(names, f.courseIds, { none: "None" })}`,
    f.courseTypeIds?.length && `course type: ${list(names, f.courseTypeIds)}`,
    f.followUp !== "any" && `follow-up: ${f.followUp}`,
    f.uncontactedOnly && "not contacted yet",
    f.unopenedOnly && "not opened yet",
    range({ created: "created", assigned: "assigned", followUp: "follow-up", lastContact: "last contact" }[f.dateField ?? "created"], f.dateFrom, f.dateTo),
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : "no filters";
}

const STATUS_LABEL: Record<string, string> = {
  not_handed_over: "Not handed over yet", new_customer: "New customer", onboarding: "Onboarding", active: "Active", flagged: "Flagged for review", withdrawn: "Withdrawn",
};
const PAYMENT_STATE: Record<string, string> = { paid: "fully paid", balance: "balance left", overdue: "overdue", pending: "waiting for review", none: "no payment yet", refunded: "refunded" };

export async function describeEnrollmentFilters(tx: Tx, f: EnrollmentFilters): Promise<string> {
  const names = await namesFor(tx, [...f.programIds, ...f.courseTypeIds, ...f.courseIds, ...f.teacherIds, ...f.salesAgentIds, ...f.supportOwnerIds]);
  const parts = [
    f.search.trim() && `search "${f.search.trim()}"`,
    f.programIds.length && `program: ${list(names, f.programIds)}`,
    f.courseTypeIds.length && `course type: ${list(names, f.courseTypeIds)}`,
    f.courseIds.length && `course: ${list(names, f.courseIds)}`,
    f.teacherIds.length && `teacher: ${list(names, f.teacherIds)}`,
    f.salesAgentIds.length && `sales agent: ${list(names, f.salesAgentIds, { none: "None" })}`,
    f.supportOwnerIds.length && `support owner: ${list(names, f.supportOwnerIds, { none: "None" })}`,
    f.statuses.length && `status: ${f.statuses.map((s) => STATUS_LABEL[s]).join(", ")}`,
    f.paymentStates.length && `payment: ${f.paymentStates.map((s) => PAYMENT_STATE[s]).join(", ")}`,
    f.currency && `currency: ${f.currency}`,
    range("enrolled", f.enrolledFrom, f.enrolledTo),
    range("course starts", f.startFrom, f.startTo),
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : "no filters";
}

// ── Leads ────────────────────────────────────────────────────────────────

const SOURCE: Record<string, string> = { google_sheet: "Google Sheet", manual: "Added in the CRM" };

const LEAD_COLUMNS: Column[] = [
  { header: "Name", type: "text", width: 24 }, { header: "Phone", type: "text", width: 17 }, { header: "Student", type: "text", width: 20 },
  { header: "Program", type: "text", width: 12 }, { header: "Source", type: "text", width: 16 }, { header: "Stage", type: "text", width: 16 },
  { header: "Last outcome", type: "text", width: 18 }, { header: "Sales agent", type: "text", width: 18 }, { header: "Tags", type: "text", width: 22 },
  { header: "Created", type: "datetime" }, { header: "Assigned", type: "datetime" }, { header: "First contact", type: "datetime" },
  { header: "Last contact", type: "datetime" }, { header: "Next follow-up", type: "datetime" }, { header: "Course of interest", type: "text", width: 28 },
  { header: "Enrolled", type: "text", width: 9 },
];

function leadOrder(tx: Tx, q: Pick<LeadQuery, "sort">) {
  const dir = q.sort.dir === "asc" ? tx`asc` : tx`desc`;
  const key = {
    name: tx`lower(c.name)`, program: tx`p.sort`, stage: tx`s.sort`, outcome: tx`o.sort`, followup: tx`nf.due_at`,
    owner: tx`pr.full_name`, lastContact: tx`i.last_contact_at`, created: tx`i.created_at`,
  }[q.sort.key] ?? tx`i.created_at`;
  return tx`${key} ${dir} nulls last, i.created_at desc, i.id`;
}

/** The Leads list as an Excel file, exactly what the filters show (managers only), and its audit line. */
export async function leadsWorkbook(staff: Staff, q: Pick<LeadQuery, "filters" | "sort">): Promise<{ file: Buffer; name: string; rows: number }> {
  return asUser(staff.id, async (tx) => {
    const rows = await tx<Row[]>`
      select c.name, c.phone_normalized as phone, i.student_name, p.name as program, i.source, s.label as stage, o.label as outcome,
             pr.full_name as owner,
             (select string_agg(t.name, ', ' order by t.name) from public.inquiry_tags it join public.tags t on t.id = it.tag_id where it.inquiry_id = i.id) as tags,
             i.created_at, i.assigned_at, i.first_contact_attempt_at, i.last_contact_at, nf.due_at as next_follow_up,
             (select name from public.courses where id = i.course_id) as course,
             exists (select 1 from public.enrollments e where e.inquiry_id = i.id) as enrolled
        from public.inquiries i
        join public.contacts c on c.id = i.contact_id
        join public.stages s on s.id = i.stage_id
        join public.programs p on p.id = i.program_id
        left join public.contact_outcomes o on o.id = i.last_outcome_id
        left join public.profiles pr on pr.id = i.sales_owner_id
        left join lateral (
          select f.id, f.due_at from public.follow_ups f where f.inquiry_id = i.id and f.status = 'open' order by f.due_at limit 1
        ) nf on true
       where ${filterSql(tx, q.filters)}
       order by ${leadOrder(tx, q)}
       limit ${MAX_EXPORT_ROWS + 1}`;
    if (rows.length > MAX_EXPORT_ROWS) {
      const [{ n }] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.inquiries i join public.contacts c on c.id = i.contact_id join public.stages s on s.id = i.stage_id
          join public.programs p on p.id = i.program_id left join public.contact_outcomes o on o.id = i.last_outcome_id
          left join public.profiles pr on pr.id = i.sales_owner_id
          left join lateral (select f.id, f.due_at from public.follow_ups f where f.inquiry_id = i.id and f.status = 'open' order by f.due_at limit 1) nf on true
         where ${filterSql(tx, q.filters)}`;
      tooMany(n, "leads");
    }
    const label = await describeLeadFilters(tx, q.filters);
    // Records the download (and refuses anyone but a manager) in the same transaction as the read.
    await tx`select public.log_lead_export(${tx.json({ rows: rows.length, label, filters: q.filters, sort: q.sort } as unknown as Parameters<Tx["json"]>[0])})`;
    const sheet: Sheet = {
      name: "Leads",
      columns: LEAD_COLUMNS,
      rows: rows.map((r) => [
        r.name as string, r.phone as string, r.student_name as string | null, r.program as string, SOURCE[String(r.source)] ?? String(r.source),
        r.stage as string, r.outcome as string | null, (r.owner as string | null) ?? "Unassigned", r.tags as string | null,
        r.created_at as Date, r.assigned_at as Date | null, r.first_contact_attempt_at as Date | null, r.last_contact_at as Date | null,
        r.next_follow_up as Date | null, r.course as string | null, r.enrolled ? "Yes" : "No",
      ]),
    };
    return { file: buildXlsx([sheet]), name: `leads-${cairoStamp()}.xlsx`, rows: rows.length };
  });
}

// ── Enrollments, payments and the payment plan ───────────────────────────

const KIND: Record<string, string> = { deposit: "Deposit", installment: "Installment", full: "Full payment", refund: "Refund" };
const METHOD: Record<string, string> = { bank_transfer: "Bank transfer", instapay: "InstaPay", mobile_wallet: "Mobile wallet", cash: "Cash", card: "Card", other: "Other" };
const PAY_STATUS: Record<string, string> = { pending: "Waiting for review", confirmed: "Confirmed", rejected: "Rejected", reversed: "Reversed", refunded: "Refunded" };
const DUE_STATUS: Record<string, string> = { paid: "Paid", overdue: "Overdue", due_today: "Due today", partly_paid: "Partly paid", upcoming: "Upcoming" };

interface ExportPayment {
  customerName: string; phone: string | null; studentName: string | null; courseName: string; currency: string; paidOn: string; amount: number;
  kind: string | null; method: string; reference: string | null; status: string; submittedBy: string | null; submittedAt: string;
  decidedBy: string | null; decidedAt: string | null; salesAgentName: string | null;
}
interface ExportDue {
  customerName: string; phone: string | null; studentName: string | null; courseName: string; currency: string; dueOn: string;
  amount: number; covered: number; status: string; note: string | null;
}
type EnrollmentExport = EnrollmentList & { payments: ExportPayment[]; plan: ExportDue[] };

/**
 * The Enrollments list as an Excel file with three sheets (managers and accountants). The database
 * applies the role and records the download in the audit log.
 */
export async function enrollmentsWorkbook(staff: Staff, q: EnrollmentExportQuery): Promise<{ file: Buffer; name: string; rows: number }> {
  return asUser(staff.id, async (tx) => {
    const label = await describeEnrollmentFilters(tx, q.filters);
    const [{ r }] = await tx<{ r: EnrollmentExport }[]>`select public.enrollments_list(${tx.json({ ...q, scope: "all", export: true, label })}) as r`;
    const phones = true; // Phase 1: the accountant sees phone numbers too (the database decides what each role gets)
    const ph = <T,>(cols: T[]): T[] => (phones ? cols : []);
    const enrollments: Sheet = {
      name: "Enrollments",
      columns: [
        { header: "Customer", type: "text", width: 24 }, ...ph<Column>([{ header: "Phone", type: "text", width: 17 }]), { header: "Student", type: "text", width: 20 },
        { header: "Program", type: "text", width: 12 }, { header: "Course type", type: "text", width: 16 }, { header: "Course", type: "text", width: 30 },
        { header: "Enrolled on", type: "date" }, { header: "Course starts", type: "date" }, { header: "Sales agent", type: "text" },
        { header: "Support owner", type: "text" }, { header: "Teacher", type: "text" }, { header: "Support status", type: "text" },
        { header: "Currency", type: "text", width: 9 }, { header: "Agreed total", type: "money" }, { header: "Paid", type: "money" },
        { header: "Waiting for review", type: "money" }, { header: "Balance", type: "money" }, { header: "Refunded", type: "money" }, { header: "Last payment", type: "date" },
        { header: "Next due date", type: "date" }, { header: "Next due amount", type: "money" }, { header: "Overdue", type: "money" },
        { header: "Package hours", type: "number", width: 10 }, { header: "Hours used", type: "number", width: 10 }, { header: "Hours left", type: "number", width: 10 },
        { header: "Added as existing customer", type: "text", width: 12 },
      ],
      rows: r.rows.map((x) => [
        x.customerName, ...ph([x.phone]), x.studentName, x.programName, x.courseTypeName, x.courseName, x.enrolledOn ?? x.enrolledAt, x.courseStart,
        x.salesAgentName ?? "Before the CRM", x.supportOwnerName, x.teacherNames, STATUS_LABEL[x.status] ?? x.status, x.currency,
        x.agreed, x.paid, x.pending, x.balance, x.refunded, x.lastPaidOn, x.nextDueOn, x.nextDueLeft, x.overdueLeft,
        x.packageHours, x.packageHours != null ? x.packageUsed : null, x.packageHours != null ? Math.max(x.packageHours - (x.packageUsed ?? 0), 0) : null,
        x.addedAsExisting ? "Yes" : "No",
      ]),
    };
    const cur = phones ? 12 : 11;
    enrollments.totals = { label: (c) => `Total ${c}`, currencyColumn: cur, sumColumns: [cur + 1, cur + 2, cur + 3, cur + 4, cur + 5, cur + 9] };

    const payments: Sheet = {
      name: "Payments",
      columns: [
        { header: "Customer", type: "text", width: 24 }, ...ph<Column>([{ header: "Phone", type: "text", width: 17 }]), { header: "Student", type: "text", width: 20 },
        { header: "Course", type: "text", width: 30 }, { header: "Date paid", type: "date" }, { header: "Amount", type: "money" },
        { header: "Currency", type: "text", width: 9 }, { header: "Type", type: "text", width: 13 }, { header: "Method", type: "text", width: 14 },
        { header: "Reference", type: "text" }, { header: "Status", type: "text" }, { header: "Recorded by", type: "text" },
        { header: "Recorded at", type: "datetime" }, { header: "Confirmed or rejected by", type: "text" }, { header: "Decided at", type: "datetime" },
        { header: "Sales agent", type: "text" },
      ],
      rows: r.payments.map((x) => [
        x.customerName, ...ph([x.phone]), x.studentName, x.courseName, x.paidOn, x.amount, x.currency, x.kind ? KIND[x.kind] ?? x.kind : null,
        METHOD[x.method] ?? x.method, x.reference, PAY_STATUS[x.status] ?? x.status, x.submittedBy, x.submittedAt, x.decidedBy, x.decidedAt,
        x.salesAgentName ?? "Before the CRM",
      ]),
    };
    // Totals count confirmed payments minus refunds (refund rows are negative), so they match "Paid" on the Enrollments sheet.
    const pc = phones ? 1 : 0;
    payments.totals = { label: (c) => `Total confirmed, net of refunds ${c}`, currencyColumn: 5 + pc, sumColumns: [4 + pc], where: { column: 9 + pc, equals: [PAY_STATUS.confirmed, PAY_STATUS.refunded] } };

    const plan: Sheet = {
      name: "Payment plan",
      columns: [
        { header: "Customer", type: "text", width: 24 }, ...ph<Column>([{ header: "Phone", type: "text", width: 17 }]), { header: "Student", type: "text", width: 20 },
        { header: "Course", type: "text", width: 30 }, { header: "Due date", type: "date" }, { header: "Amount", type: "money" },
        { header: "Paid so far", type: "money" }, { header: "Left", type: "money" }, { header: "Currency", type: "text", width: 9 },
        { header: "Status", type: "text" }, { header: "Note", type: "text", width: 30 },
      ],
      rows: r.plan.map((x) => [
        x.customerName, ...ph([x.phone]), x.studentName, x.courseName, x.dueOn, x.amount, x.covered, Math.max(Number(x.amount) - Number(x.covered), 0),
        x.currency, DUE_STATUS[x.status] ?? x.status, x.note,
      ]),
    };
    plan.totals = { label: (c) => `Total ${c}`, currencyColumn: 7 + pc, sumColumns: [4 + pc, 5 + pc, 6 + pc] };

    return { file: buildXlsx([enrollments, payments, plan]), name: `enrollments-${cairoStamp()}.xlsx`, rows: r.rows.length };
  });
}
