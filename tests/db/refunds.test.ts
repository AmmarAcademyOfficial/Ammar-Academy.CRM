/**
 * CRM changes plan 3, release 4 (28 Oct 2026): refunds. Support and sales request; managers and the
 * accountant record (counting at once) or decline. Withdraw ends the course (future sessions, unpaid
 * planned payments, teacher, support status); Keep studying lowers the agreed total. Refunds count in
 * balances, Accounting, the Customers list and Excel, Reports and Deleted items. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, cairoDate, closeDb, createInquiry, createUser, expectError, type TestUser } from "./helpers";

let manager: TestUser, accountant: TestUser, agent: TestUser, other: TestUser, support: TestUser;
let prog: string, course: string, teacher: string, rate: string;

const one = async <T,>(user: TestUser, sql: string, params: unknown[]) => as(user, async (q) => (await q<{ r: T }>(sql, params))[0].r);
const enroll = (user: TestUser, p: Record<string, unknown>) => one<string>(user, "select public.save_enrollment($1) as r", [p]);
const pay = (user: TestUser, enrollment: string, amount: number, extra: Record<string, unknown> = {}) =>
  one<string>(user, "select public.submit_payment($1) as r", [{ enrollment_id: enrollment, amount, paid_on: cairoDate(), method: "cash", kind: "installment", ...extra }]);
const request = (user: TestUser, p: Record<string, unknown>) => one<string>(user, "select public.request_refund($1) as r", [p]);
const record = (user: TestUser, p: Record<string, unknown>) =>
  one<{ id: string; withdrawn: boolean; sessionsRemoved: number; duesCancelled: number; flagged: boolean }>(user, "select public.record_refund($1) as r",
    [{ refunded_on: cairoDate(), method: "cash", reason: "goodwill", outcome: "keep", ...p }]);
const decline = (user: TestUser, id: string, reason: string) => as(user, (q) => q("select public.decline_refund($1, $2)", [id, reason]));
const totals = async (enrollment: string) =>
  (await admin<{ agreed: string; paid: string; pending: string }>("select agreed::text, paid::text, pending::text from private.enrollment_totals($1)", [enrollment]))[0];
const listRow = async (user: TestUser, enrollment: string, filters: Record<string, unknown> = {}) => {
  const r = await one<{ rows: { enrollmentId: string; paid: number; refunded: number; balance: number; status: string }[] }>(user, "select public.enrollments_list($1) as r",
    [{ filters: { programIds: [prog], ...filters }, scope: "all", pageSize: 100 }]);
  return r.rows.find((x) => x.enrollmentId === enrollment);
};
const notes = (user: TestUser, like: string) =>
  admin<{ text: string; kind: string }>("select text, kind from public.notifications where user_id = $1 and text like $2 order by created_at", [user.id, like]);

/** A 10,000 EGP enrollment of agent's lead, 3,000 confirmed (handed over to support), a planned payment, a teacher, a past and a future session. */
async function customer() {
  const inquiry = (await createInquiry(agent, { program_id: prog })).inquiry_id;
  const enrollment = await enroll(agent, { inquiry_id: inquiry, course_id: course, agreed_total: 10000 });
  await pay(manager, enrollment, 3000, { kind: "deposit" });
  await admin("update public.onboardings set support_owner_id = $2, claimed_at = now() where enrollment_id = $1", [enrollment, support.id]);
  await admin("insert into public.payment_dues (enrollment_id, due_on, amount, created_by) values ($1, current_date + 20, 7000, $2)", [enrollment, manager.id]);
  const [{ id: a }] = await admin<{ id: string }>("insert into public.teacher_assignments (teacher_id, rate_id, enrollment_id, started_on) values ($1, $2, $3, '2026-09-01') returning id", [teacher, rate, enrollment]);
  await admin(`insert into public.teacher_sessions (assignment_id, teacher_id, rate_id, enrollment_id, starts_at, planned_hours, status, hours, paid_hours, student_hours)
               values ($1, $2, $3, $4, now() - interval '3 days', 1, 'done', 1, 1, 1), ($1, $2, $3, $4, now() + interval '5 days', 1, 'scheduled', null, 0, 0)`, [a, teacher, rate, enrollment]);
  return { inquiry, enrollment, assignment: a };
}

beforeAll(async () => {
  manager = await createUser("manager", "Ref Manager");
  accountant = await createUser("accountant", "Ref Accountant");
  agent = await createUser("sales", "Ref Agent");
  other = await createUser("sales", "Ref Other Agent");
  support = await createUser("support", "Ref Support");
  [{ id: prog }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('REFX', 'Refund Program') returning id");
  await admin("update public.app_settings set handover_trigger = 'qualifying_deposit', deposit_rule = deposit_rule || jsonb_build_object($1::text, jsonb_build_object('kind', 'percent', 'value', 30))", [prog]);
  const typeId = await one<string>(manager, "select public.save_course_type($1) as r", [{ name: "Ref Type", color: "blue" }]);
  course = await one<string>(manager, "select public.save_course($1) as r", [{ program_id: prog, course_type_id: typeId, name: "Ref Course", price: 10000, currency: "EGP", delivery: "online" }]);
  teacher = (await admin<{ id: string }>("insert into public.teachers (full_name) values ('Ref Teacher') returning id"))[0].id;
  rate = (await admin<{ id: string }>("insert into public.teacher_rates (teacher_id, name) values ($1, 'Hour') returning id", [teacher]))[0].id;
  await admin("insert into public.teacher_rate_amounts (rate_id, amount, valid_from) values ($1, 200, '2026-01-01')", [rate]);
});
afterAll(async () => {
  await admin("update public.profiles set active = false where id = any($1)", [[accountant.id, agent.id, other.id, support.id]]);
  await admin("update public.profiles set active = false where id = $1", [manager.id]).catch(() => {});
  await closeDb();
});

describe("requesting a refund", () => {
  it("support and the lead's agent may ask; another agent may not; managers and the accountant are told", async () => {
    const c = await customer();
    await expectError(request(other, { enrollment_id: c.enrollment, amount: 500, reason: "withdrew" }), "CRM04"); // not their lead
    await expectError(request(support, { enrollment_id: c.enrollment, amount: 3500, reason: "withdrew" }), "CRM01", "more than what the customer paid");
    await expectError(request(support, { enrollment_id: c.enrollment, amount: 500, reason: "other" }), "CRM01", "Write the reason");
    const id = await request(support, { enrollment_id: c.enrollment, amount: 3000, reason: "withdrew", note: "Moved abroad" });
    expect(id).toBeTruthy();
    await expectError(request(agent, { enrollment_id: c.enrollment, amount: 100, reason: "overpaid" }), "CRM01", "already waiting");
    expect((await notes(accountant, "Refund requested: %"))[0]).toMatchObject({ kind: "refund_requested" });
    expect((await notes(manager, "Refund requested: %")).length).toBeGreaterThan(0);
    // Nothing counts until it is recorded.
    expect(await totals(c.enrollment)).toMatchObject({ paid: "3000.00" });
    const q = await one<{ refundRequests: { id: string; amount: number; reason: string; requestedBy: string }[] }>(accountant, "select public.review_queue() as r", []);
    expect(q.refundRequests.find((x) => x.id === id)).toMatchObject({ amount: 3000, reason: "withdrew", requestedBy: "Ref Support" });
  });

  it("nothing confirmed means nothing to refund", async () => {
    const inquiry = (await createInquiry(agent, { program_id: prog })).inquiry_id;
    const e = await enroll(agent, { inquiry_id: inquiry, course_id: course, agreed_total: 10000 });
    await pay(agent, e, 1000); // pending only
    await expectError(request(agent, { enrollment_id: e, amount: 100, reason: "overpaid" }), "CRM01", "Nothing confirmed");
  });
});

describe("recording a refund", () => {
  it("only managers and the accountant record or decline", async () => {
    const c = await customer();
    await expectError(record(support, { enrollment_id: c.enrollment, amount: 100 }), "CRM03");
    await expectError(record(agent, { enrollment_id: c.enrollment, amount: 100 }), "CRM03");
    const id = await request(support, { enrollment_id: c.enrollment, amount: 100, reason: "overpaid" });
    await expectError(decline(support, id, "No"), "CRM03");
  });

  it("checks the amount, date, reference, reason and outcome", async () => {
    const c = await customer();
    await expectError(record(manager, { enrollment_id: c.enrollment, amount: 3000.5 }), "CRM01", "more than what the customer paid");
    await expectError(record(manager, { enrollment_id: c.enrollment, amount: 100, refunded_on: "2099-01-01" }), "CRM01", "future");
    await expectError(record(manager, { enrollment_id: c.enrollment, amount: 100, method: "bank_transfer" }), "CRM01", "reference");
    await expectError(record(manager, { enrollment_id: c.enrollment, amount: 100, outcome: null }), "CRM01", "Withdraw or Keep studying");
    await expectError(record(manager, { enrollment_id: c.enrollment, amount: 100, reason: "other" }), "CRM01", "Write the reason");
  });

  it("Keep studying: counts at once, the agreed total drops, and everyone concerned is told", async () => {
    const c = await customer();
    const r = await record(accountant, { enrollment_id: c.enrollment, amount: 1000, method: "instapay", reference: "IPN-REF-1", reason: "goodwill", note: "Late discount" });
    expect(r).toMatchObject({ withdrawn: false, sessionsRemoved: 0, duesCancelled: 0 });
    expect(await totals(c.enrollment)).toMatchObject({ agreed: "9000.00", paid: "2000.00" });
    expect(Number((await totals(c.enrollment)).pending)).toBe(0);
    const row = await listRow(manager, c.enrollment);
    expect(row).toMatchObject({ paid: 2000, refunded: 1000, balance: 7000 });
    expect((await listRow(manager, c.enrollment, { paymentStates: ["refunded"] }))?.enrollmentId).toBe(c.enrollment);
    expect((await notes(support, "Refund recorded: %"))[0]).toMatchObject({ kind: "refund_update" });
    expect((await notes(agent, "Refund recorded: %")).length).toBe(1);
    const line = await admin<{ body: string }>("select body from public.activities where inquiry_id = $1 and type = 'refund'", [c.inquiry]);
    expect(line[0].body).toBe("Refund recorded: Ref Course · 1,000 EGP · Goodwill or discount · Keeps studying; agreed total now 9,000 EGP · Late discount");
    const acc = await one<{ id: string; amount: number; currency: string; outcome: string }[]>(manager, "select public.accounting_refunds($1, $2) as r", [cairoDate(), cairoDate()]);
    expect(acc.find((x) => x.id === r.id)).toMatchObject({ amount: 1000, currency: "EGP", outcome: "keep" });
    // A planned payment counts the refund: 2,000 net covers less of the plan.
    const due = await admin<{ covered: string }>("select covered::text from private.dues_state($1)", [c.enrollment]);
    expect(Number(due[0].covered)).toBeLessThanOrEqual(2000);
  });

  it("Withdraw from a request: future sessions, unpaid planned payments and the teacher end; support shows Withdrawn", async () => {
    const c = await customer();
    const id = await request(support, { enrollment_id: c.enrollment, amount: 3000, reason: "withdrew" });
    const r = await record(manager, { request_id: id, amount: 3000, reason: "withdrew", outcome: "withdraw" });
    expect(r).toMatchObject({ id, withdrawn: true, sessionsRemoved: 1, duesCancelled: 1 });
    const s = await admin<{ status: string }>("select status from public.teacher_sessions where enrollment_id = $1", [c.enrollment]);
    expect(s.map((x) => x.status)).toEqual(["done"]); // the past session stays
    expect((await admin<{ ended_on: string | null }>("select ended_on::text from public.teacher_assignments where id = $1", [c.assignment]))[0].ended_on).toBe(cairoDate());
    expect((await admin<{ status: string }>("select status::text from public.onboardings where enrollment_id = $1", [c.enrollment]))[0].status).toBe("withdrawn");
    expect(await listRow(manager, c.enrollment)).toMatchObject({ status: "withdrawn", paid: 0, refunded: 3000, balance: 0 });
    expect((await admin<{ status: string }>("select status from public.refunds where id = $1", [id]))[0].status).toBe("recorded");
    await expectError(pay(manager, c.enrollment, 100), "CRM01", "withdrew from this course");
    const ob = (await admin<{ id: string }>("select id from public.onboardings where enrollment_id = $1", [c.enrollment]))[0].id;
    await expectError(as(support, (q) => q("select public.set_onboarding_status($1, 'onboarding')", [ob])), "CRM01", "withdrew from the course");
    await expectError(request(support, { enrollment_id: c.enrollment, amount: 1, reason: "other", note: "x" }), "CRM01", "already withdrawn");
    expect((await notes(support, "Refund recorded: %withdrew")).length).toBeGreaterThan(0);
  });

  it("declining tells the person who asked, and a decided request cannot be decided again", async () => {
    const c = await customer();
    const id = await request(agent, { enrollment_id: c.enrollment, amount: 500, reason: "overpaid" });
    await expectError(decline(manager, id, " "), "CRM01", "reason");
    await decline(manager, id, "Paid amount matches the agreed total");
    expect((await notes(agent, "Refund declined: %"))[0].text).toMatch(/Paid amount matches the agreed total$/);
    await expectError(decline(manager, id, "again"), "CRM01", "already decided");
    await expectError(record(manager, { request_id: id, amount: 500 }), "CRM01", "already decided");
    expect(await totals(c.enrollment)).toMatchObject({ paid: "3000.00" });
  });
});

describe("refunds everywhere else", () => {
  it("Reports: confirmed money net of refunds, refunds and withdrawals on their own", async () => {
    const c = await customer();
    await record(manager, { enrollment_id: c.enrollment, amount: 3000, reason: "withdrew", outcome: "withdraw" });
    const r = await one<{ confirmed: { currency: string; amount: number }[]; refunds: { currency: string; amount: number; count: number }[]; withdrawals: number; enrollments: number }>(
      manager, "select public.report($1) as r", [{ from: cairoDate(), to: cairoDate(), program_id: prog }]);
    const egp = (xs: { currency: string; amount: number }[]) => Number(xs.find((x) => x.currency === "EGP")?.amount ?? 0);
    expect(egp(r.refunds)).toBeGreaterThanOrEqual(3000);
    expect(r.withdrawals).toBeGreaterThanOrEqual(1);
    const gross = (await admin<{ s: string }>("select coalesce(sum(p.amount), 0)::text as s from public.payments p join public.enrollments e on e.id = p.enrollment_id join public.courses co on co.id = e.course_id where co.program_id = $1 and p.status = 'confirmed'", [prog]))[0].s;
    expect(egp(r.confirmed)).toBe(Number(gross) - egp(r.refunds));
    expect(r.enrollments).toBeGreaterThan(0); // a withdrawn enrollment still counts on its day
  });

  it("the Excel download lists refunds as negative rows on the Payments sheet", async () => {
    const c = await customer();
    await record(manager, { enrollment_id: c.enrollment, amount: 250, reason: "overpaid" });
    const r = await one<{ payments: { enrollmentId: string; amount: number; kind: string; status: string }[] }>(manager, "select public.enrollments_list($1) as r",
      [{ filters: { programIds: [prog] }, sort: { key: "customer", dir: "asc" }, export: true, label: "refund test" }]);
    expect(r.payments.filter((x) => x.enrollmentId === c.enrollment).map((x) => [x.amount, x.kind, x.status])).toEqual([[3000, "deposit", "confirmed"], [-250, "refund", "refunded"]]);
  });

  it("deleting an enrollment takes its refunds, and restoring brings them back", async () => {
    const c = await customer();
    const r = await record(manager, { enrollment_id: c.enrollment, amount: 400, reason: "overpaid" });
    const prev = await one<{ summary: string }>(manager, "select public.delete_preview('enrollment', $1) as r", [c.enrollment]);
    expect(prev.summary).toMatch(/^1 enrollment, 1 payment/);
    const d = await one<{ id: string }>(manager, "select public.delete_record($1) as r", [{ kind: "enrollment", id: c.enrollment, reason: "Test", confirm: "DELETE" }]);
    expect((await admin("select 1 from public.refunds where id = $1", [r.id])).length).toBe(0);
    await one(manager, "select public.restore_deleted($1) as r", [d.id]);
    expect((await admin<{ amount: string }>("select amount::text from public.refunds where id = $1", [r.id]))[0].amount).toBe("400.00");
    expect(await totals(c.enrollment)).toMatchObject({ agreed: "9600.00", paid: "2600.00" });
  });

  it("support and sales read the refunds of customers they can see, not others", async () => {
    const c = await customer();
    await record(manager, { enrollment_id: c.enrollment, amount: 100, reason: "overpaid" });
    expect((await as(support, (q) => q("select id from public.refunds r where r.enrollment_id = $1", [c.enrollment]))).length).toBe(1);
    expect((await as(other, (q) => q("select id from public.refunds r where r.enrollment_id = $1", [c.enrollment]))).length).toBe(0);
  });
});
