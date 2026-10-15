import "server-only";
import type postgres from "postgres";
import type { FollowUpItem, LeadDetail, LeadPage, LeadQuery, LeadRowDTO, MyWork, NotificationList, Overview, Reference, WorkBucket } from "@/domain/dto";
import { latinDigits, normalizePhone } from "@/domain/rules";
import type { Activity, FieldValue, FollowUp, LeadFilters, SavedView } from "@/domain/types";
import type { Staff } from "./auth";
import { asUser, type Tx } from "./db";
import { eligibilityRows, openReviewCount, sheetHealth } from "./import-queries";
import { mapActivity, mapAudit, mapChecklistItem, mapCourse, mapCourseType, mapEnrollment, mapField, mapFollowUp, mapLeadRow, mapNotification, mapOnboarding, mapOutcome, mapPayment, mapProfile, mapProgram, mapSettings, mapStage, mapSupportFollowUp, mapTag } from "./mappers";
import { withDefaults } from "@/domain/filters";

type Frag = postgres.Fragment;
type Row = Record<string, unknown>;

// ── Reference data ───────────────────────────────────────────────────────

export async function loadReference(staff: Staff): Promise<Reference> {
  return asUser(staff.id, async (tx) => {
    const [profiles, programs, courses, courseTypes, checklist, stages, outcomes, tags, fields, options, settings, views, prefs] = await Promise.all([
      tx<Row[]>`select * from public.profiles order by role, rotation_order, full_name`,
      tx<Row[]>`select * from public.programs order by sort`,
      tx<Row[]>`select * from public.courses order by active desc, start_date nulls last, name`,
      tx<Row[]>`select * from public.course_types order by sort`,
      tx<Row[]>`select * from public.checklist_template order by archived, sort`,
      tx<Row[]>`select * from public.stages order by sort`,
      tx<Row[]>`select * from public.contact_outcomes order by sort`,
      tx<Row[]>`select * from public.tags order by archived, name`,
      tx<Row[]>`select id, key, label, type, importance, required_from, program_ids::text[] as program_ids, visible_to::text[] as visible_to, editable_by::text[] as editable_by, sort, archived from public.field_definitions order by sort`,
      tx<Row[]>`select * from public.field_options order by sort`,
      tx<Row[]>`select * from public.app_settings where id = 1`,
      tx<Row[]>`select * from public.saved_views where user_id = ${staff.id} order by created_at`,
      tx<Row[]>`select lead_columns from public.user_preferences where user_id = ${staff.id}`,
    ]);
    return {
      profiles: profiles.map(mapProfile),
      programs: programs.map(mapProgram),
      courses: courses.map(mapCourse),
      courseTypes: courseTypes.map(mapCourseType),
      checklist: checklist.map(mapChecklistItem),
      stages: stages.map(mapStage),
      outcomes: outcomes.map(mapOutcome),
      tags: tags.map(mapTag),
      fields: fields.map((f) => mapField(f, options.filter((o) => o.field_id === f.id))),
      settings: mapSettings(settings[0]),
      savedViews: views.map((v): SavedView => ({ id: String(v.id), name: String(v.name), builtIn: false, filters: withDefaults(v.filters as LeadFilters) })),
      leadColumns: (prefs[0]?.lead_columns as string[] | null) ?? null,
    };
  });
}

// ── Lead list ────────────────────────────────────────────────────────────

/** Columns every lead row needs. Joined tables are visible to the user through RLS. */
function leadSelect(tx: Tx, where: Frag, orderBy: Frag, limit: number, offset: number) {
  return tx<Row[]>`
    select
      i.id, i.contact_id, i.program_id, i.student_name, i.stage_id, i.last_outcome_id, i.sales_owner_id,
      i.primary_tag_id, i.source, i.source_connection_id, i.created_at, i.assigned_at,
      i.first_contact_attempt_at, i.last_contact_at, i.no_follow_up_reason, i.lost_reason,
      i.reserved, i.reserved_note, i.course_id, i.version,
      c.name as c_name, c.phone as c_phone, c.phone_normalized as c_phone_normalized,
      c.phone_secondary_normalized as c_phone_secondary, c.contact_type as c_contact_type,
      c.do_not_contact as c_dnc, c.do_not_contact_reason as c_dnc_reason, c.created_at as c_created_at,
      coalesce((select array_agg(t.tag_id::text) from public.inquiry_tags t where t.inquiry_id = i.id), '{}') as tag_ids,
      nf.id as nf_id, nf.due_at as nf_due_at, nf.note as nf_note, nf.owner_id as nf_owner_id,
      count(*) over () as total
    from public.inquiries i
    join public.contacts c on c.id = i.contact_id
    join public.stages s on s.id = i.stage_id
    join public.programs p on p.id = i.program_id
    left join public.contact_outcomes o on o.id = i.last_outcome_id
    left join public.profiles pr on pr.id = i.sales_owner_id
    left join lateral (
      select f.id, f.due_at, f.note, f.owner_id from public.follow_ups f
      where f.inquiry_id = i.id and f.status = 'open' order by f.due_at limit 1
    ) nf on true
    where ${where}
    order by ${orderBy}, i.created_at desc, i.id
    limit ${limit} offset ${offset}`;
}

const CAIRO_TODAY = (tx: Tx) => tx`(now() at time zone 'Africa/Cairo')::date`;

/** Phone search variants: as typed, normalized (+20…), and without the local leading zero. */
function phoneDigits(search: string): string[] {
  const typed = latinDigits(search).replace(/\D/g, "");
  if (typed.length < 3) return [];
  const variants = new Set([typed, normalizePhone(search).replace(/\D/g, "")]);
  if (typed.startsWith("0")) variants.add(typed.slice(1));
  return [...variants].filter((v) => v.length >= 3);
}

export function filterSql(tx: Tx, f: LeadFilters): Frag {
  const parts: Frag[] = [tx`true`];
  const s = f.search.trim();
  if (s) {
    const like = `%${s.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    const digits = phoneDigits(s);
    parts.push(tx`(
      c.name ilike ${like} or coalesce(i.student_name, '') ilike ${like}
      ${digits.length ? tx`or regexp_replace(c.phone_normalized, '[^0-9]', '', 'g') like any (${digits.map((d) => `%${d}%`)}::text[])
           or regexp_replace(coalesce(c.phone_secondary_normalized, ''), '[^0-9]', '', 'g') like any (${digits.map((d) => `%${d}%`)}::text[])` : tx``}
    )`);
  }
  if (f.programIds.length) parts.push(tx`i.program_id = any (${f.programIds}::uuid[])`);
  if (f.stageKeys.length) parts.push(tx`s.system_key::text = any (${f.stageKeys}::text[])`);
  if (f.outcomeIds.length) parts.push(tx`i.last_outcome_id = any (${f.outcomeIds}::uuid[])`);
  if (f.tagIds.length) parts.push(tx`exists (select 1 from public.inquiry_tags t where t.inquiry_id = i.id and t.tag_id = any (${f.tagIds}::uuid[]))`);
  if (f.primaryColors.length) parts.push(tx`exists (select 1 from public.tags pt where pt.id = i.primary_tag_id and pt.color = any (${f.primaryColors}::text[]))`);
  if (f.ownerIds.length) {
    const ids = f.ownerIds.filter((x) => x !== "unassigned");
    const unassigned = f.ownerIds.includes("unassigned");
    parts.push(tx`(${ids.length ? tx`i.sales_owner_id = any (${ids}::uuid[])` : tx`false`} ${unassigned ? tx`or i.sales_owner_id is null` : tx``})`);
  }
  const courseIds = f.courseIds ?? [];
  if (courseIds.length) {
    const ids = courseIds.filter((x) => x !== "none");
    parts.push(tx`(${ids.length ? tx`i.course_id = any (${ids}::uuid[])` : tx`false`} ${courseIds.includes("none") ? tx`or i.course_id is null` : tx``})`);
  }
  if (f.courseTypeIds?.length) {
    parts.push(tx`exists (select 1 from public.courses cr where cr.id = i.course_id and cr.course_type_id = any (${f.courseTypeIds}::uuid[]))`);
  }
  if (f.uncontactedOnly) parts.push(tx`i.first_contact_attempt_at is null`);
  switch (f.followUp) {
    case "overdue":
      parts.push(tx`nf.due_at < now()`);
      break;
    case "today":
      parts.push(tx`nf.due_at >= now() and (nf.due_at at time zone 'Africa/Cairo')::date = ${CAIRO_TODAY(tx)}`);
      break;
    case "upcoming":
      parts.push(tx`nf.due_at >= now() and (nf.due_at at time zone 'Africa/Cairo')::date > ${CAIRO_TODAY(tx)}`);
      break;
    case "none":
      parts.push(tx`nf.id is null and not s.is_closed`);
      break;
  }
  if (f.dateFrom || f.dateTo) {
    const col = { created: tx`i.created_at`, assigned: tx`i.assigned_at`, followUp: tx`nf.due_at`, lastContact: tx`i.last_contact_at` }[f.dateField ?? "created"];
    const day = tx`(${col} at time zone 'Africa/Cairo')::date`;
    parts.push(tx`${col} is not null`);
    if (f.dateFrom) parts.push(tx`${day} >= ${f.dateFrom}::date`);
    if (f.dateTo) parts.push(tx`${day} <= ${f.dateTo}::date`);
  }
  return parts.reduce((a, b) => tx`${a} and ${b}`);
}

function orderSql(tx: Tx, q: LeadQuery): Frag {
  const dir = q.sort.dir === "asc" ? tx`asc` : tx`desc`;
  const key = {
    name: tx`lower(c.name)`,
    program: tx`p.sort`,
    stage: tx`s.sort`,
    outcome: tx`o.sort`,
    followup: tx`nf.due_at`,
    owner: tx`pr.full_name`,
    lastContact: tx`i.last_contact_at`,
    created: tx`i.created_at`,
  }[q.sort.key];
  return tx`${key ?? tx`i.created_at`} ${dir} nulls last`;
}

export async function listLeads(staff: Staff, q: LeadQuery): Promise<LeadPage> {
  const pageSize = Math.min(Math.max(q.pageSize, 5), 100);
  return asUser(staff.id, async (tx) => {
    const rows = await leadSelect(tx, filterSql(tx, q.filters), orderSql(tx, q), pageSize, Math.max(q.page, 0) * pageSize);
    return { rows: rows.map(mapLeadRow), total: Number(rows[0]?.total ?? 0) };
  });
}

// ── One lead ─────────────────────────────────────────────────────────────

export async function getLeadDetail(staff: Staff, id: string): Promise<LeadDetail | null> {
  return asUser(staff.id, async (tx) => {
    const rows = await leadSelect(tx, tx`i.id = ${id}`, tx`i.id`, 1, 0);
    if (!rows.length) return null; // not visible to this user
    const [acts, revs, fus, vals, enr] = await Promise.all([
      tx<Row[]>`select * from public.activities where inquiry_id = ${id} order by created_at desc, id desc`,
      tx<Row[]>`select r.* from public.note_revisions r join public.activities a on a.id = r.activity_id where a.inquiry_id = ${id} order by r.edited_at`,
      tx<Row[]>`select * from public.follow_ups where inquiry_id = ${id} order by status = 'open' desc, due_at`,
      tx<Row[]>`select field_id, value from public.field_values where inquiry_id = ${id}`,
      tx<Row[]>`select * from public.enrollments where inquiry_id = ${id}`,
    ]);
    const activities: Activity[] = acts.map((a) => mapActivity(a, revs.filter((r) => r.activity_id === a.id)));
    const fieldValues: Record<string, FieldValue> = {};
    vals.forEach((v) => (fieldValues[String(v.field_id)] = v.value as FieldValue));
    const row = mapLeadRow(rows[0]);
    row.inquiry.customFields = fieldValues;
    const detail: LeadDetail = { row, activities, followUps: fus.map(mapFollowUp), fieldValues, payments: [], supportFollowUps: [] };
    if (enr[0]) {
      const e = mapEnrollment(enr[0]);
      const [pays, onb] = await Promise.all([
        tx<Row[]>`select * from public.payments where enrollment_id = ${e.id} order by submitted_at desc`,
        tx<Row[]>`select * from public.onboardings where enrollment_id = ${e.id}`,
      ]);
      detail.enrollment = e;
      detail.payments = pays.map(mapPayment);
      detail.totals = totalsOf(e.agreedTotal, detail.payments);
      if (onb[0]) {
        const [items, sfus] = await Promise.all([
          tx<Row[]>`select * from public.onboarding_items where onboarding_id = ${String(onb[0].id)} order by sort`,
          tx<Row[]>`select * from public.support_follow_ups where onboarding_id = ${String(onb[0].id)} order by status = 'open' desc, due_at`,
        ]);
        detail.onboarding = mapOnboarding(onb[0], items);
        detail.supportFollowUps = sfus.map(mapSupportFollowUp);
      }
    }
    return detail;
  });
}

/** Only confirmed payments count; pending is shown separately. */
export function totalsOf(agreed: number, payments: { amount: number; status: string }[]) {
  const paid = payments.filter((p) => p.status === "confirmed").reduce((t, p) => t + p.amount, 0);
  const pending = payments.filter((p) => p.status === "pending").reduce((t, p) => t + p.amount, 0);
  return { agreed, paid, pending, balance: Math.max(agreed - paid, 0) };
}

// ── My Work ──────────────────────────────────────────────────────────────

/** Open, contactable inquiries assigned to the signed-in agent. */
function workBase(tx: Tx, staff: Staff): Frag {
  return tx`not s.is_closed and not c.do_not_contact and i.sales_owner_id = ${staff.id}`;
}

function bucketSql(tx: Tx, b: WorkBucket): Frag {
  switch (b) {
    case "overdue":
      return tx`nf.due_at < now()`;
    case "today":
      return tx`nf.due_at >= now() and (nf.due_at at time zone 'Africa/Cairo')::date = ${CAIRO_TODAY(tx)}`;
    case "uncontacted":
      return tx`i.first_contact_attempt_at is null`;
    case "new":
      return tx`i.assigned_at > now() - interval '24 hours'`;
    case "payment":
      return tx`s.system_key = 'awaiting_payment'`;
    case "noaction":
      return tx`nf.id is null and i.no_follow_up_reason is null and i.first_contact_attempt_at is not null`;
  }
}

const BUCKET_ORDER: Record<WorkBucket, (tx: Tx) => Frag> = {
  overdue: (tx) => tx`nf.due_at asc`,
  today: (tx) => tx`nf.due_at asc`,
  uncontacted: (tx) => tx`i.created_at asc`,
  new: (tx) => tx`i.assigned_at desc`,
  payment: (tx) => tx`i.last_contact_at asc nulls first`,
  noaction: (tx) => tx`i.last_contact_at asc nulls first`,
};

export async function myWork(staff: Staff, bucket: WorkBucket): Promise<MyWork> {
  return asUser(staff.id, async (tx) => {
    const base = workBase(tx, staff);
    const [counts] = await tx<Row[]>`
      select
        count(*) filter (where ${bucketSql(tx, "overdue")}) as overdue,
        count(*) filter (where ${bucketSql(tx, "today")}) as today,
        count(*) filter (where ${bucketSql(tx, "uncontacted")}) as uncontacted,
        count(*) filter (where ${bucketSql(tx, "new")}) as new,
        count(*) filter (where ${bucketSql(tx, "payment")}) as payment,
        count(*) filter (where ${bucketSql(tx, "noaction")}) as noaction
      from public.inquiries i
      join public.contacts c on c.id = i.contact_id
      join public.stages s on s.id = i.stage_id
      left join lateral (
        select f.id, f.due_at from public.follow_ups f where f.inquiry_id = i.id and f.status = 'open' order by f.due_at limit 1
      ) nf on true
      where ${base}`;
    const rows = await leadSelect(tx, tx`${base} and ${bucketSql(tx, bucket)}`, BUCKET_ORDER[bucket](tx), 50, 0);
    return {
      counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])) as Record<WorkBucket, number>,
      rows: rows.map(mapLeadRow),
    };
  });
}

// ── Follow-ups ───────────────────────────────────────────────────────────

export async function listFollowUps(staff: Staff): Promise<FollowUpItem[]> {
  return asUser(staff.id, async (tx) => {
    const fus = await tx<Row[]>`
      select f.* from public.follow_ups f
      join public.inquiries i on i.id = f.inquiry_id
      where f.status = 'open' ${staff.role === "manager" ? tx`` : tx`and f.owner_id = ${staff.id}`}
      order by f.due_at limit 500`;
    if (!fus.length) return [];
    const leads = await leadSelect(tx, tx`i.id = any (${fus.map((f) => String(f.inquiry_id))}::uuid[])`, tx`i.id`, 500, 0);
    const byId = new Map(leads.map((r) => [String(r.id), mapLeadRow(r)]));
    return fus.flatMap((f) => {
      const lead = byId.get(String(f.inquiry_id));
      return lead ? [{ followUp: mapFollowUp(f), lead }] : [];
    });
  });
}

// ── Manager overview ─────────────────────────────────────────────────────

export async function overview(staff: Staff): Promise<Overview> {
  return asUser(staff.id, async (tx) => {
    const [[stats], queue, perAgent, audit] = await Promise.all([
      tx<Row[]>`
        select
          (select count(*) from public.inquiries i where (i.created_at at time zone 'Africa/Cairo')::date = ${CAIRO_TODAY(tx)}) as new_today,
          (select count(*) from public.follow_ups f where f.status = 'open' and f.due_at < now()) as overdue`,
      leadSelect(tx, tx`i.sales_owner_id is null and not s.is_closed`, tx`i.created_at asc`, 50, 0),
      tx<Row[]>`
        select i.sales_owner_id as user_id, count(*) as open,
               count(*) filter (where exists (select 1 from public.follow_ups f where f.inquiry_id = i.id and f.status = 'open' and f.due_at < now())) as overdue
        from public.inquiries i join public.stages s on s.id = i.stage_id
        where not s.is_closed and i.sales_owner_id is not null
        group by i.sales_owner_id`,
      tx<Row[]>`select * from public.audit_log order by created_at desc limit 8`,
    ]);
    const [eligibility, sheets, reviewOpen, [pc]] = await Promise.all([eligibilityRows(tx), sheetHealth(tx), openReviewCount(tx),
      tx<Row[]>`select (select count(*) from public.payments where status = 'pending') as pending,
                       (select count(*) from public.onboardings where flagged_reason is not null) as flagged`]);
    return {
      newToday: Number(stats.new_today),
      overdueFollowUps: Number(stats.overdue),
      queue: queue.map(mapLeadRow),
      openByAgent: perAgent.map((r) => ({ userId: String(r.user_id), open: Number(r.open), overdue: Number(r.overdue) })),
      audit: audit.map(mapAudit),
      eligibility,
      sheets,
      reviewOpen,
      paymentsPending: Number(pc.pending),
      onboardingFlagged: Number(pc.flagged),
    };
  });
}

// ── Notifications ────────────────────────────────────────────────────────

export async function listNotifications(staff: Staff): Promise<NotificationList> {
  return asUser(staff.id, async (tx) => {
    const rows = await tx<Row[]>`select * from public.notifications where user_id = ${staff.id} order by created_at desc limit 30`;
    const [{ n }] = await tx<Row[]>`select count(*) as n from public.notifications where user_id = ${staff.id} and read_at is null`;
    return { items: rows.map(mapNotification), unread: Number(n) };
  });
}

export type { FollowUp, LeadRowDTO };

// ── Audit history (managers) ─────────────────────────────────────────────

export const AUDIT_PAGE_SIZE = 50;

export async function auditPage(staff: Staff, f: { q: string; actor: string; page: number }) {
  return asUser(staff.id, async (tx) => {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const where = tx`
      where (${f.q} = '' or a.action ilike ${like} or a.target ilike ${like})
        and (${f.actor} = '' or (${f.actor} = 'system' and a.actor_id is null) or a.actor_id::text = ${f.actor})`;
    const [rows, [{ n }]] = await Promise.all([
      tx<Row[]>`select a.* from public.audit_log a ${where} order by a.created_at desc limit ${AUDIT_PAGE_SIZE} offset ${f.page * AUDIT_PAGE_SIZE}`,
      tx<Row[]>`select count(*) as n from public.audit_log a ${where}`,
    ]);
    return { items: rows.map(mapAudit), total: Number(n), pageSize: AUDIT_PAGE_SIZE };
  });
}
