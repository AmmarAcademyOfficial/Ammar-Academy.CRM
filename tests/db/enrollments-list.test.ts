/**
 * CRM changes, Part B (26 Oct 2026): the Enrollments list — combined filters, payment states,
 * sorting, paging, totals per currency, and what each role sees. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createInquiry, createUser, expectError, type TestUser } from "./helpers";

let manager: TestUser, accountant: TestUser, s1: TestUser, s2: TestUser, sup1: TestUser, sup2: TestUser;
let prog: string, courseA: string, courseB: string, typeId: string;
const c: Record<string, { enrollment: string; inquiry: string }> = {};

interface Row { customerName: string; phone: string | null; status: string; currency: string; paid: number; balance: number; overdueLeft: number; pending: number; salesAgentId: string | null; supportOwnerId: string | null; courseStart: string | null; teacherNames: string | null }
interface List { total: number; rows: Row[]; totals: { currency: string; count: number; agreed: number; paid: number; balance: number }[]; scope: string }

const list = (user: TestUser, filters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  as(user, async (q) => (await q<{ r: List }>("select public.enrollments_list($1) as r", [{ filters: { programIds: [prog], ...filters }, ...extra }]))[0].r);
const names = (l: List) => l.rows.map((r) => r.customerName).sort();

async function customer(key: string, opts: { agent: TestUser; course: string; agreed: number; enrolledOn: string; support?: TestUser | null; status?: string; flagged?: boolean }) {
  const inquiry = (await createInquiry(opts.agent, { program_id: prog, name: `Enrl ${key}` })).inquiry_id;
  const enrollment = await as(opts.agent, async (q) => (await q<{ id: string }>("select public.save_enrollment($1) as id",
    [{ inquiry_id: inquiry, course_id: opts.course, agreed_total: opts.agreed, price_note: "Test price" }]))[0].id);
  await admin("update public.enrollments set created_at = $2::date + time '12:00' where id = $1", [enrollment, opts.enrolledOn]);
  if (opts.support !== undefined) {
    await admin("insert into public.onboardings (enrollment_id, support_owner_id, claimed_at, status, flagged_reason) values ($1, $2, now(), $3, $4)",
      [enrollment, opts.support?.id ?? null, opts.status ?? "onboarding", opts.flagged ? "Payment reversed" : null]);
  }
  c[key] = { enrollment, inquiry };
  return enrollment;
}
const pay = (enrollment: string, amount: number, status: "confirmed" | "pending", paidOn: string, by: TestUser) =>
  admin("insert into public.payments (enrollment_id, amount, paid_on, method, status, submitted_by) values ($1, $2, $3, 'instapay', $4, $5)", [enrollment, amount, paidOn, status, by.id]);

beforeAll(async () => {
  manager = await createUser("manager", "Enrl Manager");
  accountant = await createUser("accountant", "Enrl Accountant");
  s1 = await createUser("sales", "Enrl Sales One");
  s2 = await createUser("sales", "Enrl Sales Two");
  sup1 = await createUser("support", "Enrl Support One");
  sup2 = await createUser("support", "Enrl Support Two");
  [{ id: prog }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('ENRL', 'Enrollment Program') returning id");
  typeId = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course_type($1) as id", [{ name: "Enrl Group", color: "teal" }]))[0].id);
  const mk = (p: Record<string, unknown>) => as(manager, async (q) => (await q<{ id: string }>("select public.save_course($1) as id",
    [{ program_id: prog, course_type_id: typeId, delivery: "online", ...p }]))[0].id);
  courseA = await mk({ name: "Enrl Course A", price: 1000, currency: "EGP", start_date: "2026-11-01" });
  courseB = await mk({ name: "Enrl Course B", price: 400, currency: "USD", start_date: "2027-01-10" });

  const e1 = await customer("Paid", { agent: s1, course: courseA, agreed: 1000, enrolledOn: "2026-09-10", support: sup1, status: "active" });
  await pay(e1, 1000, "confirmed", "2026-09-10", s1);
  const e2 = await customer("Overdue", { agent: s2, course: courseA, agreed: 1000, enrolledOn: "2026-10-05", support: sup2 });
  await pay(e2, 300, "confirmed", "2026-10-05", s2);
  await admin("insert into public.payment_dues (enrollment_id, due_on, amount, created_by) values ($1, '2026-10-15', 500, $2)", [e2, sup2.id]);
  await customer("Usd", { agent: s1, course: courseB, agreed: 400, enrolledOn: "2026-10-20" });
  const e4 = await customer("Flagged", { agent: s1, course: courseA, agreed: 1000, enrolledOn: "2026-10-22", support: sup1, flagged: true });
  await pay(e4, 200, "pending", "2026-10-22", s1);
  const t = (await admin<{ id: string }>("insert into public.teachers (full_name) values ('Enrl Teacher') returning id"))[0].id;
  const r = (await admin<{ id: string }>("insert into public.teacher_rates (teacher_id, name) values ($1, 'Hour') returning id", [t]))[0].id;
  await admin("insert into public.teacher_assignments (teacher_id, rate_id, enrollment_id, started_on) values ($1, $2, $3, '2026-10-01')", [t, r, e2]);
});
afterAll(async () => {
  await admin("update public.profiles set active = false where id = any($1)", [[accountant.id, s1.id, s2.id, sup1.id, sup2.id]]);
  await admin("update public.profiles set active = false where id = $1", [manager.id]).catch(() => {});
  await closeDb();
});

describe("the list", () => {
  it("lists every enrollment with balances, statuses, teacher and payment details", async () => {
    const l = await list(manager);
    expect(l.total).toBe(4);
    const by = Object.fromEntries(l.rows.map((r) => [r.customerName, r]));
    expect(by["Enrl Paid"]).toMatchObject({ status: "active", paid: 1000, balance: 0, overdueLeft: 0, courseStart: "2026-11-01" });
    expect(by["Enrl Overdue"]).toMatchObject({ status: "onboarding", paid: 300, balance: 700, overdueLeft: 500, teacherNames: "Enrl Teacher" });
    expect(by["Enrl Usd"]).toMatchObject({ status: "not_handed_over", currency: "USD", paid: 0, balance: 400 });
    expect(by["Enrl Flagged"]).toMatchObject({ status: "flagged", pending: 200 });
    expect(by["Enrl Paid"].phone).toMatch(/^\+?\d+/);
  });

  it("combines every filter: all of them must match", async () => {
    expect(names(await list(manager, { courseIds: [courseA] }))).toEqual(["Enrl Flagged", "Enrl Overdue", "Enrl Paid"]);
    expect(names(await list(manager, { courseIds: [courseA], salesAgentIds: [s1.id] }))).toEqual(["Enrl Flagged", "Enrl Paid"]);
    expect(names(await list(manager, { courseIds: [courseA], salesAgentIds: [s1.id], paymentStates: ["balance"] }))).toEqual(["Enrl Flagged"]);
    expect(names(await list(manager, { courseIds: [courseA], salesAgentIds: [s1.id], paymentStates: ["balance"], supportOwnerIds: [sup2.id] }))).toEqual([]);
    expect(names(await list(manager, { enrolledFrom: "2026-10-01", enrolledTo: "2026-10-21" }))).toEqual(["Enrl Overdue", "Enrl Usd"]);
    expect(names(await list(manager, { startFrom: "2027-01-01" }))).toEqual(["Enrl Usd"]);
    expect(names(await list(manager, { statuses: ["flagged", "not_handed_over"] }))).toEqual(["Enrl Flagged", "Enrl Usd"]);
    expect(names(await list(manager, { paymentStates: ["overdue", "pending"] }))).toEqual(["Enrl Flagged", "Enrl Overdue"]);
    expect(names(await list(manager, { paymentStates: ["paid"] }))).toEqual(["Enrl Paid"]);
    expect(names(await list(manager, { paymentStates: ["none"] }))).toEqual(["Enrl Flagged", "Enrl Usd"]);
    expect(names(await list(manager, { supportOwnerIds: ["none"] }))).toEqual(["Enrl Usd"]); // not handed over yet
    expect(names(await list(manager, { currency: "USD" }))).toEqual(["Enrl Usd"]);
    expect(names(await list(manager, { courseTypeIds: [typeId], search: "overd" }))).toEqual(["Enrl Overdue"]);
  });

  it("sorts, pages and totals per currency over everything that matches", async () => {
    const byBalance = await list(manager, {}, { sort: { key: "balance", dir: "desc" } });
    expect(byBalance.rows.map((r) => r.customerName)).toEqual(["Enrl Flagged", "Enrl Overdue", "Enrl Usd", "Enrl Paid"]);
    const byName = await list(manager, {}, { sort: { key: "customer", dir: "asc" }, pageSize: 5, page: 0 });
    expect(byName.rows[0].customerName).toBe("Enrl Flagged");
    const page2 = await list(manager, {}, { sort: { key: "customer", dir: "asc" }, pageSize: 5, page: 1 });
    expect([page2.total, page2.rows.length]).toEqual([4, 0]);
    expect(byName.totals).toEqual([
      { currency: "EGP", count: 3, agreed: 3000, paid: 1300, balance: 1700, overdue: 500 },
      { currency: "USD", count: 1, agreed: 400, paid: 0, balance: 400, overdue: 0 },
    ]);
  });
});

describe("who sees what", () => {
  it("accountants see every enrollment but no phone numbers, and cannot search by phone", async () => {
    const l = await list(accountant);
    expect(l.total).toBe(4);
    expect(l.rows.every((r) => r.phone === null)).toBe(true);
    const phone = (await admin<{ phone_normalized: string }>("select c.phone_normalized from public.contacts c join public.inquiries i on i.contact_id = c.id where i.id = $1", [c.Paid.inquiry]))[0].phone_normalized;
    expect((await list(accountant, { search: phone.slice(-6) })).total).toBe(0);
    expect((await list(manager, { search: phone.slice(-6) })).total).toBe(1);
  });

  it("support sees their own customers by default, every customer with 'all'", async () => {
    const mine = await list(sup1);
    expect([mine.scope, names(mine)]).toEqual(["mine", ["Enrl Flagged", "Enrl Paid"]]);
    expect(names(await list(sup2))).toEqual(["Enrl Overdue"]);
    expect((await list(sup2, {}, { scope: "all" })).total).toBe(4);
  });

  it("sales agents cannot use it", async () => {
    await expectError(list(s1), "CRM03");
  });
});
