/**
 * CRM changes plan 3, release 2 (28 Oct 2026): delete payments, enrollments, leads and customers,
 * with Deleted items and 30 days to restore. Who may delete, the reason and the word DELETE,
 * what goes with each record, closed salary months, the Google Sheets ledger, the handover flag,
 * restore with the same ids and history, and the 30-day purge. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, cairoDate, closeDb, createInquiry, createUser, expectError, type TestUser } from "./helpers";

let manager: TestUser, accountant: TestUser, agent: TestUser, support: TestUser;
let prog: string, course: string, teacher: string, rate: string;

const one = async <T,>(user: TestUser, sql: string, params: unknown[]) => as(user, async (q) => (await q<{ r: T }>(sql, params))[0].r);
const enroll = (user: TestUser, p: Record<string, unknown>) => one<string>(user, "select public.save_enrollment($1) as r", [p]);
const pay = (user: TestUser, enrollment: string, amount: number, extra: Record<string, unknown> = {}) =>
  one<string>(user, "select public.submit_payment($1) as r", [{ enrollment_id: enrollment, amount, paid_on: cairoDate(), method: "cash", kind: "installment", ...extra }]);
interface Preview { label: string; summary: string; leads: number; enrollments: number; payments: number; sessions: number; people: number; confirmed: Record<string, number>; needsTyped: boolean; closedMonth: string | null }
const preview = (user: TestUser, kind: string, id: string) => one<Preview>(user, "select public.delete_preview($1, $2) as r", [kind, id]);
const del = (user: TestUser, p: Record<string, unknown>) => one<{ id: string; summary: string; flagged: boolean }>(user, "select public.delete_record($1) as r", [p]);
const items = (user: TestUser) => one<{ id: string; kind: string; label: string; summary: string; deletedById: string }[]>(user, "select public.deleted_items() as r", []);
const restore = (user: TestUser, id: string) => one<{ kind: string; queued: number }>(user, "select public.restore_deleted($1) as r", [id]);
const count = async (sql: string, params: unknown[]) => (await admin<{ n: number }>(`select count(*)::int as n from ${sql}`, params))[0].n;
const fingerprint = (inquiry: string) => admin<{ f: string }>(`
  select md5(concat_ws('|',
    (select string_agg(to_jsonb(i)::text, ',') from public.inquiries i where id = $1),
    (select string_agg(to_jsonb(a)::text, ',' order by a.id) from public.activities a where inquiry_id = $1 and type <> 'deleted'),
    (select string_agg(to_jsonb(e)::text, ',' order by e.id) from public.enrollments e where inquiry_id = $1),
    (select string_agg(to_jsonb(p)::text, ',' order by p.id) from public.payments p join public.enrollments e on e.id = p.enrollment_id where e.inquiry_id = $1),
    (select string_agg(to_jsonb(o)::text, ',' order by o.id) from public.onboardings o join public.enrollments e on e.id = o.enrollment_id where e.inquiry_id = $1),
    (select string_agg(to_jsonb(s)::text, ',' order by s.id) from public.teacher_sessions s join public.enrollments e on e.id = s.enrollment_id where e.inquiry_id = $1),
    (select string_agg(to_jsonb(d)::text, ',' order by d.id) from public.payment_dues d join public.enrollments e on e.id = d.enrollment_id where e.inquiry_id = $1))) as f`, [inquiry]).then((r) => r[0].f);

/** A lead with a 10,000 EGP enrollment: a confirmed 3,000 deposit (handed over to support), a pending 1,000, a planned payment, a teacher and two sessions. */
async function customer() {
  const inquiry = (await createInquiry(agent, { program_id: prog })).inquiry_id;
  const enrollment = await enroll(agent, { inquiry_id: inquiry, course_id: course, agreed_total: 10000 });
  const confirmed = await pay(manager, enrollment, 3000, { kind: "deposit" });
  const pending = await pay(agent, enrollment, 1000);
  await admin("update public.onboardings set support_owner_id = $2, claimed_at = now() where enrollment_id = $1", [enrollment, support.id]);
  await admin("insert into public.payment_dues (enrollment_id, due_on, amount, created_by) values ($1, '2027-01-10', 6000, $2)", [enrollment, manager.id]);
  const [{ id: a }] = await admin<{ id: string }>("insert into public.teacher_assignments (teacher_id, rate_id, enrollment_id, started_on) values ($1, $2, $3, '2026-10-01') returning id", [teacher, rate, enrollment]);
  for (const at of ["2026-12-02T15:00:00Z", "2026-12-09T15:00:00Z"]) {
    await admin("insert into public.teacher_sessions (assignment_id, teacher_id, rate_id, enrollment_id, starts_at, planned_hours, status) values ($1, $2, $3, $4, $5, 1, 'scheduled')", [a, teacher, rate, enrollment, at]);
  }
  return { inquiry, enrollment, confirmed, pending, contact: (await admin<{ contact_id: string }>("select contact_id from public.inquiries where id = $1", [inquiry]))[0].contact_id };
}

beforeAll(async () => {
  manager = await createUser("manager", "Del Manager");
  accountant = await createUser("accountant", "Del Accountant");
  agent = await createUser("sales", "Del Agent");
  support = await createUser("support", "Del Support");
  [{ id: prog }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('DELX', 'Delete Program') returning id");
  await admin("update public.app_settings set handover_trigger = 'qualifying_deposit', deposit_rule = deposit_rule || jsonb_build_object($1::text, jsonb_build_object('kind', 'percent', 'value', 30))", [prog]);
  const typeId = await one<string>(manager, "select public.save_course_type($1) as r", [{ name: "Del Type", color: "blue" }]);
  course = await one<string>(manager, "select public.save_course($1) as r", [{ program_id: prog, course_type_id: typeId, name: "Del Course", price: 10000, currency: "EGP", delivery: "online" }]);
  teacher = (await admin<{ id: string }>("insert into public.teachers (full_name) values ('Del Teacher') returning id"))[0].id;
  rate = (await admin<{ id: string }>("insert into public.teacher_rates (teacher_id, name) values ($1, 'Hour') returning id", [teacher]))[0].id;
  await admin("insert into public.teacher_rate_amounts (rate_id, amount, valid_from) values ($1, 200, '2026-01-01')", [rate]);
});
afterAll(async () => {
  await admin("update public.profiles set active = false where id = any($1)", [[accountant.id, agent.id, support.id]]);
  await admin("update public.profiles set active = false where id = $1", [manager.id]).catch(() => {});
  await closeDb();
});

describe("who may delete", () => {
  it("managers delete anything; the accountant payments only; support and sales nothing", async () => {
    const c = await customer();
    await expectError(preview(accountant, "enrollment", c.enrollment), "CRM03");
    await expectError(preview(accountant, "lead", c.inquiry), "CRM03");
    await expectError(del(accountant, { kind: "customer", id: c.contact, reason: "x" }), "CRM03");
    await expectError(del(support, { kind: "payment", id: c.pending, reason: "x" }), "CRM03");
    await expectError(del(agent, { kind: "payment", id: c.pending, reason: "x" }), "CRM03");
    expect((await preview(accountant, "payment", c.pending)).summary).toBe("1 payment");
    expect((await preview(manager, "lead", c.inquiry)).leads).toBe(1);
    await expect(as(agent, (q) => q("select * from public.deleted_records"))).rejects.toThrow(/permission denied/);
  });

  it("a reason is required, and the word DELETE when confirmed money goes", async () => {
    const c = await customer();
    await expectError(del(manager, { kind: "payment", id: c.confirmed, reason: " " }), "CRM01", "reason");
    const p = await preview(manager, "payment", c.confirmed);
    expect(p).toMatchObject({ needsTyped: true, confirmed: { EGP: 3000 }, summary: "1 payment (3,000 EGP confirmed)" });
    await expectError(del(manager, { kind: "payment", id: c.confirmed, reason: "Duplicate" }), "CRM01", "Type DELETE");
    await expectError(del(manager, { kind: "payment", id: c.confirmed, reason: "Duplicate", confirm: "delete" }), "CRM01", "Type DELETE");
    expect((await preview(manager, "payment", c.pending)).needsTyped).toBe(false);
    await del(manager, { kind: "payment", id: c.pending, reason: "Entered twice" });
    expect(await count("public.payments where id = $1", [c.pending])).toBe(0);
  });
});

describe("what goes with each record", () => {
  it("an enrollment takes its payments, plan, onboarding, teacher and sessions; the lead stays", async () => {
    const c = await customer();
    const p = await preview(manager, "enrollment", c.enrollment);
    expect(p.summary).toBe("1 enrollment, 2 payments (3,000 EGP confirmed), 2 sessions");
    const r = await del(manager, { kind: "enrollment", id: c.enrollment, reason: "Wrong course", confirm: "DELETE" });
    expect(r.summary).toBe(p.summary);
    for (const t of ["payments", "payment_dues", "onboardings", "teacher_assignments", "teacher_sessions"]) {
      expect(await count(`public.${t} where enrollment_id = $1`, [c.enrollment])).toBe(0);
    }
    expect(await count("public.inquiries where id = $1", [c.inquiry])).toBe(1);
    const line = await admin<{ body: string }>("select body from public.activities where inquiry_id = $1 and type = 'deleted'", [c.inquiry]);
    expect(line[0].body).toMatch(/^Enrollment deleted: .* · Del Course · Wrong course$/);
    const audit = await admin<{ action: string; actor_id: string }>("select action, actor_id from public.audit_log where details ->> 'record_id' = $1", [c.enrollment]);
    expect(audit[0]).toMatchObject({ action: "Deleted enrollment (Wrong course)", actor_id: manager.id });
  });

  it("a lead takes everything under it, and the person when it was their only lead", async () => {
    const c = await customer();
    expect((await preview(manager, "lead", c.inquiry)).summary).toBe("1 person, 1 lead, 1 enrollment, 2 payments (3,000 EGP confirmed), 2 sessions");
    const second = (await createInquiry(agent, { program_id: prog, phone_normalized: (await admin<{ p: string }>("select phone_normalized as p from public.contacts where id = $1", [c.contact]))[0].p })).inquiry_id;
    expect(second).not.toBe(c.inquiry);
    // With another lead, the person stays.
    expect((await preview(manager, "lead", second)).people).toBe(0);
    await del(manager, { kind: "lead", id: second, reason: "Duplicate lead" });
    expect(await count("public.contacts where id = $1", [c.contact])).toBe(1);
    expect(await count("public.inquiries where contact_id = $1", [c.contact])).toBe(1);
  });

  it("a person takes every lead, enrollment and payment", async () => {
    const c = await customer();
    const other = (await createInquiry(agent, { program_id: prog, phone_normalized: (await admin<{ p: string }>("select phone_normalized as p from public.contacts where id = $1", [c.contact]))[0].p })).inquiry_id;
    expect(other).toBeTruthy();
    const p = await preview(manager, "customer", c.contact);
    expect(p).toMatchObject({ people: 1, leads: 2, enrollments: 1, payments: 2, needsTyped: true });
    await del(manager, { kind: "customer", id: c.contact, reason: "Test record", confirm: "DELETE" });
    expect(await count("public.contacts where id = $1", [c.contact])).toBe(0);
    expect(await count("public.inquiries where contact_id = $1", [c.contact])).toBe(0);
    expect(await count("public.enrollments where id = $1", [c.enrollment])).toBe(0);
  });
});

describe("safety rules", () => {
  it("sessions in a closed salary month block the delete until the month is reopened", async () => {
    const c = await customer();
    await admin("insert into public.salary_months (month, status) values ('2026-12-01', 'closed') on conflict (month) do update set status = 'closed'");
    expect((await preview(manager, "enrollment", c.enrollment)).closedMonth).toBe("December 2026");
    await expectError(del(manager, { kind: "lead", id: c.inquiry, reason: "x", confirm: "DELETE" }), "CRM01", "closed salary month (December 2026)");
    expect(await count("public.enrollments where id = $1", [c.enrollment])).toBe(1);
    // A payment alone has no sessions, so it can still go.
    await del(manager, { kind: "payment", id: c.pending, reason: "Entered twice" });
    await admin("update public.salary_months set status = 'open' where month = '2026-12-01'");
    await del(manager, { kind: "enrollment", id: c.enrollment, reason: "Wrong course", confirm: "DELETE" });
  });

  it("deleting a payment flags the customer when they drop below the handover rule", async () => {
    const c = await customer();
    // 30% of 10,000 is 3,000; without the confirmed 3,000 only the pending 1,000 is left.
    const r = await del(manager, { kind: "payment", id: c.confirmed, reason: "Bank error", confirm: "DELETE" });
    expect(r.flagged).toBe(true);
    const o = (await admin<{ flagged_reason: string | null; support_owner_id: string }>("select flagged_reason, support_owner_id from public.onboardings where enrollment_id = $1", [c.enrollment]))[0];
    expect(o.flagged_reason).toMatch(/^A payment of 3,000 EGP was deleted \(Bank error\)/);
    expect(o.support_owner_id).toBe(support.id); // never taken back from support
  });

  it("a deleted Google Sheets lead keeps its ledger row, so the next sync does not import it again", async () => {
    const c = await customer();
    const [{ id: acct }] = await admin<{ id: string }>("insert into public.google_accounts (email) values ('del-sheet@example.test') returning id");
    const [{ id: conn }] = await admin<{ id: string }>(`insert into public.sheet_connections (google_account_id, spreadsheet_id, spreadsheet_name, sheet_title, sheet_gid, program_id, headers, mapping, identity, import_mode, created_by)
      values ($1, 'del-sheet-0001', 'Del Sheet', 'Form', 1, $2, '{}', '[]', 'phone_program', 'all', $3) returning id`, [acct, prog, manager.id]);
    await admin("insert into public.sheet_rows (connection_id, row_key, row_number, outcome, inquiry_id) values ($1, 'row-7', 7, 'imported', $2)", [conn, c.inquiry]);
    const r = await del(manager, { kind: "lead", id: c.inquiry, reason: "Spam", confirm: "DELETE" });
    const row = await admin<{ inquiry_id: string | null; outcome: string }>("select inquiry_id, outcome from public.sheet_rows where connection_id = $1 and row_key = 'row-7'", [conn]);
    expect(row).toEqual([{ inquiry_id: null, outcome: "imported" }]);
    const again = await admin<{ r: { outcome: string } }>("select private.import_sheet_row($1, 'row-7', 7, '{}'::jsonb) as r", [conn]);
    expect(again[0].r.outcome).toBe("already");
    await restore(manager, r.id);
    expect((await admin<{ inquiry_id: string }>("select inquiry_id from public.sheet_rows where connection_id = $1 and row_key = 'row-7'", [conn]))[0].inquiry_id).toBe(c.inquiry);
  });
});

describe("Deleted items and restore", () => {
  it("restoring a lead puts everything back exactly as it was, with the same ids and history", async () => {
    const c = await customer();
    const before = await fingerprint(c.inquiry);
    const n = await count("public.notifications where inquiry_id = $1", [c.inquiry]);
    const r = await del(manager, { kind: "lead", id: c.inquiry, reason: "Mistake", confirm: "DELETE" });
    expect(await count("public.inquiries where id = $1", [c.inquiry])).toBe(0);
    const listed = (await items(manager)).find((x) => x.id === r.id);
    expect(listed).toMatchObject({ kind: "lead", summary: "1 person, 1 lead, 1 enrollment, 2 payments (3,000 EGP confirmed), 2 sessions", deletedById: manager.id });
    expect(await restore(manager, r.id)).toMatchObject({ kind: "lead", queued: 0 });
    expect(await fingerprint(c.inquiry)).toBe(before);
    // No "new lead" alert is sent again for a restored lead.
    expect(await count("public.notifications where inquiry_id = $1 and kind = 'new_lead'", [c.inquiry])).toBeLessThanOrEqual(n);
    expect((await items(manager)).some((x) => x.id === r.id)).toBe(false);
    const audit = await admin<{ action: string }>("select action from public.audit_log where action = 'Restored lead' and details ->> 'record_id' = $1", [c.inquiry]);
    expect(audit.length).toBe(1);
  });

  it("a restored lead whose sales agent has left goes back to the queue", async () => {
    const leaver = await createUser("sales", "Del Leaver");
    const inquiry = (await createInquiry(leaver, { program_id: prog })).inquiry_id;
    await admin("update public.inquiries set sales_owner_id = $2 where id = $1", [inquiry, leaver.id]);
    const r = await del(manager, { kind: "lead", id: inquiry, reason: "Mistake" });
    await admin("update public.profiles set active = false where id = $1", [leaver.id]);
    expect((await restore(manager, r.id)).queued).toBe(1);
    expect((await admin<{ s: string | null }>("select sales_owner_id as s from public.inquiries where id = $1", [inquiry]))[0].s).toBeNull();
  });

  it("the accountant sees and restores only the payments they deleted", async () => {
    const c = await customer();
    const mine = await del(accountant, { kind: "payment", id: c.pending, reason: "Entered twice" });
    const theirs = await del(manager, { kind: "payment", id: c.confirmed, reason: "Bank error", confirm: "DELETE" });
    const seen = (await items(accountant)).map((x) => x.id);
    expect(seen).toContain(mine.id);
    expect(seen).not.toContain(theirs.id);
    await expectError(restore(accountant, theirs.id), "CRM03");
    await restore(accountant, mine.id);
    expect(await count("public.payments where id = $1", [c.pending])).toBe(1);
    await expectError(as(support, (q) => q("select public.deleted_items()")), "CRM03");
  });

  it("a payment or enrollment comes back only once what it belonged to is back", async () => {
    const c = await customer();
    const p = await del(manager, { kind: "payment", id: c.pending, reason: "Entered twice" });
    const e = await del(manager, { kind: "enrollment", id: c.enrollment, reason: "Wrong course", confirm: "DELETE" });
    await expectError(restore(manager, p.id), "CRM01", "Restore the enrollment");
    await restore(manager, e.id);
    await restore(manager, p.id);
    expect(await count("public.payments where enrollment_id = $1", [c.enrollment])).toBe(2);
  });

  it("a person cannot come back over a newer record with the same phone", async () => {
    const c = await customer();
    const phone = (await admin<{ p: string }>("select phone_normalized as p from public.contacts where id = $1", [c.contact]))[0].p;
    const r = await del(manager, { kind: "customer", id: c.contact, reason: "Test", confirm: "DELETE" });
    await createInquiry(agent, { program_id: prog, phone_normalized: phone });
    await expectError(restore(manager, r.id), "CRM01", "matching record was added after the delete");
    expect((await items(manager)).some((x) => x.id === r.id)).toBe(true); // nothing half-restored, still listed
  });

  it("after 30 days a deleted record is removed for good", async () => {
    const c = await customer();
    const r = await del(manager, { kind: "payment", id: c.pending, reason: "Old" });
    await admin("update public.deleted_records set purge_after = now() - interval '1 minute' where id = $1", [r.id]);
    expect((await items(manager)).some((x) => x.id === r.id)).toBe(false);
    expect(await count("public.deleted_records where id = $1", [r.id])).toBe(0);
    const r2 = await del(manager, { kind: "payment", id: c.confirmed, reason: "Old", confirm: "DELETE" });
    await admin("update public.deleted_records set purge_after = now() - interval '1 minute' where id = $1", [r2.id]);
    expect((await admin<{ n: number }>("select private.purge_deleted(now()) as n"))[0].n).toBeGreaterThanOrEqual(1);
  });

  it("receipts of deleted payments stay on file while they can be restored", async () => {
    const c = await customer();
    await admin("update public.payments set receipt_path = 'receipts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.pdf' where id = $1", [c.pending]);
    await del(manager, { kind: "payment", id: c.pending, reason: "Entered twice" });
    const kept = await admin<{ p: string }>("select private.deleted_receipts() as p");
    expect(kept.map((x) => x.p)).toContain("receipts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.pdf");
  });
});
