/**
 * Accounting plan, phase 2 (22 Oct 2026): the accountant role and the accounting reads.
 * Accountants see payments and balances (names and amounts, no phone numbers), confirm, reject and
 * reverse payments, and are told about payments to review. They get no row access to leads.
 * Own program and people; synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createInquiry, createUser, expectError, type TestUser } from "./helpers";

let manager: TestUser, accountant: TestUser, agent: TestUser, support: TestUser;
let prog: string, course: string;
const RECEIPT = { path: "receipts/11111111-2222-4333-8444-777777777777.jpg", name: "transfer.jpg", mime: "image/jpeg", size: 1234 };
let refN = 0;
const ref = () => `ACC-${Date.now()}-${++refN}`;
const cairoToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const plusDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

async function sale(total = 10000) {
  const inquiry = (await createInquiry(agent, { program_id: prog })).inquiry_id;
  const enrollment = await as(agent, async (q) => (await q<{ id: string }>("select public.save_enrollment($1) as id",
    [{ inquiry_id: inquiry, course_id: course, agreed_total: total, price_note: total === 10000 ? null : "Test price" }]))[0].id);
  return { inquiry, enrollment };
}
const pay = (enrollment: string, amount: number, extra: Record<string, unknown> = {}) =>
  as(agent, async (q) => (await q<{ id: string }>("select public.submit_payment($1) as id", [{
    enrollment_id: enrollment, amount, paid_on: cairoToday(), method: "instapay", reference: ref(), receipt: RECEIPT, ...extra,
  }]))[0].id);
const payments = (user: TestUser, from = plusDays(cairoToday(), -1), to = cairoToday()) =>
  as(user, (q) => q<Record<string, unknown>>("select * from public.accounting_payments($1, $2)", [from, to]));
const customers = (user: TestUser) => as(user, (q) => q<Record<string, unknown>>("select * from public.accounting_customers()"));

beforeAll(async () => {
  manager = await createUser("manager", "Acc Manager");
  accountant = await createUser("accountant", "Acc Accountant");
  agent = await createUser("sales", "Acc Agent");
  support = await createUser("support", "Acc Support");
  [{ id: prog }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('ACCT', 'Accounting Program') returning id");
  const typeId = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course_type($1) as id", [{ name: "Acc Group", color: "blue" }]))[0].id);
  course = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course($1) as id",
    [{ program_id: prog, course_type_id: typeId, name: "Acc Course", price: 10000, currency: "EGP", delivery: "online" }]))[0].id);
});
afterAll(async () => {
  await admin("update public.profiles set active = false where id = any($1)", [[accountant.id, agent.id, support.id]]);
  await admin("update public.profiles set active = false where id = $1", [manager.id]).catch(() => {});
  await closeDb();
});

describe("accountant role", () => {
  it("a manager can make someone an accountant (recorded in the audit history)", async () => {
    const u = await createUser("sales", "Acc Future Accountant");
    await as(manager, (q) => q("select public.set_user_role($1, 'accountant')", [u.id]));
    expect((await admin<{ role: string }>("select role from public.profiles where id = $1", [u.id]))[0].role).toBe("accountant");
    const [a] = await admin<{ action: string }>("select action from public.audit_log where target = 'Acc Future Accountant' order by created_at desc limit 1");
    expect(a.action).toBe("Changed role sales → accountant");
    await admin("update public.profiles set active = false where id = $1", [u.id]);
  });

  it("has no row access to leads, contacts or payments", async () => {
    const s = await sale();
    await pay(s.enrollment, 1000);
    for (const table of ["inquiries", "contacts", "enrollments", "payments", "activities", "onboardings", "payment_dues"]) {
      expect(await as(accountant, (q) => q(`select 1 from public.${table} limit 1`)), table).toHaveLength(0);
    }
  });

  it("is told about payments to review; confirms, rejects and reverses them", async () => {
    const s = await sale();
    const p1 = await pay(s.enrollment, 2000);
    const told = await admin<{ kind: string; popup: boolean }>("select kind, popup from public.notifications where user_id = $1 and inquiry_id = $2", [accountant.id, s.inquiry]);
    expect(told).toEqual([{ kind: "payment_to_review", popup: true }]);
    await as(accountant, (q) => q("select public.decide_payment($1, 'confirmed', null)", [p1]));
    const p2 = await pay(s.enrollment, 1000);
    await as(accountant, (q) => q("select public.decide_payment($1, 'rejected', 'Wrong reference')", [p2]));
    await as(accountant, (q) => q("select public.reverse_payment($1, 'Bank returned it')", [p1]));
    const rows = await admin<{ id: string; status: string; decided_by: string }>("select id, status, decided_by from public.payments where enrollment_id = $1 order by submitted_at", [s.enrollment]);
    expect(rows.map((r) => [r.status, r.decided_by])).toEqual([["reversed", accountant.id], ["rejected", accountant.id]]);
    await expectError(as(support, (q) => q("select public.reverse_payment($1, 'x')", [p1])), "CRM03");
  });
});

describe("accounting reads", () => {
  it("only managers and accountants; never phone numbers", async () => {
    const s = await sale();
    await pay(s.enrollment, 1500, { kind: "deposit" });
    for (const u of [manager, accountant]) {
      const mine = (await payments(u)).filter((r) => r.enrollment_id === s.enrollment);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ amount: "1500.00", currency: "EGP", kind: "deposit", status: "pending", has_receipt: true, sales_agent_id: agent.id, submitted_by: agent.id });
      expect(Object.keys(mine[0]).some((k) => k.includes("phone"))).toBe(false);
    }
    expect(Object.keys((await customers(accountant))[0]).some((k) => k.includes("phone"))).toBe(false);
    for (const u of [agent, support]) {
      await expectError(payments(u), "CRM03");
      await expectError(customers(u), "CRM03");
    }
    await expectError(as(null, (q) => q("select * from public.accounting_customers()")), "42501");
  });

  it("filters payments by the date the customer paid; ranges are checked", async () => {
    const s = await sale();
    const old = await pay(s.enrollment, 500);
    await admin("update public.payments set paid_on = $2 where id = $1", [old, plusDays(cairoToday(), -10)]);
    const ids = (rows: Record<string, unknown>[]) => rows.map((r) => r.id);
    expect(ids(await payments(accountant))).not.toContain(old);
    expect(ids(await payments(accountant, plusDays(cairoToday(), -11), cairoToday()))).toContain(old);
    await expectError(payments(accountant, cairoToday(), plusDays(cairoToday(), -1)), "CRM01", "valid date range");
    await expectError(payments(accountant, plusDays(cairoToday(), -500), cairoToday()), "CRM01", "400 days");
  });

  it("customers show agreed, paid, pending, balance and the overdue part of the plan", async () => {
    const s = await sale();
    const p = await pay(s.enrollment, 3000);
    await as(manager, (q) => q("select public.decide_payment($1, 'confirmed', null)", [p]));
    await pay(s.enrollment, 1000);
    await admin("insert into public.payment_dues (enrollment_id, due_on, amount, created_at) values ($1, $2, 2000, now()), ($1, $3, 4000, now())",
      [s.enrollment, plusDays(cairoToday(), -4), plusDays(cairoToday(), 20)]);
    const row = (await customers(accountant)).find((r) => r.enrollment_id === s.enrollment)!;
    expect(row).toMatchObject({
      agreed_total: "10000.00", paid: "3000.00", pending: "1000.00", sales_agent_id: agent.id,
      next_due_status: "overdue", next_due_left: "2000.00", overdue_left: "2000.00",
    });
    const since = row.overdue_since as Date; // node-postgres reads a date as local midnight
    expect(`${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, "0")}-${String(since.getDate()).padStart(2, "0")}`).toBe(plusDays(cairoToday(), -4));
  });

  it("receipts open for finance staff only", async () => {
    const s = await sale();
    const p = await pay(s.enrollment, 700);
    expect(await as(accountant, (q) => q("select receipt_mime from public.accounting_receipt($1)", [p]))).toEqual([{ receipt_mime: "image/jpeg" }]);
    await expectError(as(support, (q) => q("select * from public.accounting_receipt($1)", [p])), "CRM03");
  });
});
