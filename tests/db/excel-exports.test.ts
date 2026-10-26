/**
 * CRM changes, Part C (26 Oct 2026): Excel downloads. The Enrollments export mode returns every
 * matching row with its payments and payment plan and writes the audit line itself; who may download;
 * the Leads download's audit line. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createInquiry, createUser, expectError, type TestUser } from "./helpers";

let manager: TestUser, accountant: TestUser, agent: TestUser, support: TestUser;
let prog: string, course: string;
const MANY = 130; // more than one page of the normal list (100)

interface Exported {
  total: number;
  rows: { customerName: string; phone: string | null; courseName: string; programName: string; salesAgentName: string | null; addedAsExisting: boolean; enrolledOn: string }[];
  payments: { customerName: string; phone: string | null; amount: number; status: string; submittedBy: string; decidedBy: string | null; kind: string | null }[];
  plan: { customerName: string; phone: string | null; dueOn: string; amount: number; covered: number; status: string }[];
}
const exportAs = (user: TestUser, filters: Record<string, unknown> = {}, label = "test filters") =>
  as(user, async (q) => (await q<{ r: Exported }>("select public.enrollments_list($1) as r",
    [{ filters: { programIds: [prog], ...filters }, sort: { key: "customer", dir: "asc" }, export: true, label }]))[0].r);
const audits = () => admin<{ actor_id: string; action: string; target: string; details: Record<string, unknown> }>(
  "select actor_id, action, target, details from public.audit_log where action = 'Downloaded Excel' order by created_at desc");

beforeAll(async () => {
  manager = await createUser("manager", "Export Manager");
  accountant = await createUser("accountant", "Export Accountant");
  agent = await createUser("sales", "Export Agent");
  support = await createUser("support", "Export Support");
  [{ id: prog }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('EXPT', 'Export Program') returning id");
  const typeId = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course_type($1) as id", [{ name: "Export Group", color: "blue" }]))[0].id);
  course = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course($1) as id",
    [{ program_id: prog, course_type_id: typeId, name: "Export Course", price: 1000, currency: "EGP", delivery: "online" }]))[0].id);
  // MANY enrolled customers, quickly: one through the normal functions, the rest copied in SQL.
  for (let i = 0; i < MANY; i++) {
    const inquiry = (await createInquiry(agent, { program_id: prog, name: `Export ${String(i).padStart(3, "0")}` })).inquiry_id;
    const enrollment = (await admin<{ id: string }>(
      "insert into public.enrollments (inquiry_id, course_id, agreed_total, currency, original_sales_owner_id, created_by) values ($1, $2, 1000, 'EGP', $3, $3) returning id",
      [inquiry, course, agent.id]))[0].id;
    if (i < 3) {
      await admin("insert into public.payments (enrollment_id, amount, paid_on, method, status, submitted_by, decided_by, decided_at, kind) values ($1, 400, '2026-10-01', 'cash', 'confirmed', $2, $3, now(), 'deposit')", [enrollment, agent.id, manager.id]);
      await admin("insert into public.payments (enrollment_id, amount, paid_on, method, status, submitted_by) values ($1, 100, '2026-10-02', 'instapay', 'pending', $2)", [enrollment, agent.id]);
      await admin("insert into public.payment_dues (enrollment_id, due_on, amount, created_by) values ($1, '2026-12-01', 600, $2)", [enrollment, manager.id]);
    }
  }
});
afterAll(async () => {
  await admin("update public.profiles set active = false where id = any($1)", [[accountant.id, agent.id, support.id]]);
  await admin("update public.profiles set active = false where id = $1", [manager.id]).catch(() => {});
  await closeDb();
});

describe("Enrollments download", () => {
  it("a manager gets every matching row (not one page), with payments, the plan, names and phones", async () => {
    const before = (await audits()).length;
    const r = await exportAs(manager);
    expect(r.total).toBe(MANY);
    expect(r.rows.length).toBe(MANY);
    expect(r.rows[0]).toMatchObject({ customerName: "Export 000", courseName: "Export Course", programName: "Export Program", salesAgentName: "Export Agent", addedAsExisting: false });
    expect(r.rows[0].phone).toMatch(/^\+20/);
    expect(r.payments.length).toBe(6);
    expect(r.payments[0]).toMatchObject({ customerName: "Export 000", amount: 400, status: "confirmed", kind: "deposit", submittedBy: "Export Agent", decidedBy: "Export Manager" });
    expect(r.payments[1]).toMatchObject({ customerName: "Export 000", amount: 100, status: "pending", decidedBy: null });
    expect(r.plan.length).toBe(3);
    expect(r.plan[0]).toMatchObject({ customerName: "Export 000", dueOn: "2026-12-01", amount: 600, covered: 0 });
    const a = await audits();
    expect(a.length).toBe(before + 1);
    expect(a[0]).toMatchObject({ actor_id: manager.id, target: `Enrollments · ${MANY} rows · test filters` });
    expect(a[0].details).toMatchObject({ list: "enrollments", rows: MANY, payments: 6, planned: 3 });
    expect((a[0].details.filters as { programIds: string[] }).programIds).toEqual([prog]);
  });

  it("follows the filters: only matching enrollments and their payments", async () => {
    const r = await exportAs(manager, { paymentStates: ["pending"] }, "payment: waiting for review");
    expect(r.rows.map((x) => x.customerName)).toEqual(["Export 000", "Export 001", "Export 002"]);
    expect(r.payments.length).toBe(6);
    expect((await audits())[0].target).toBe("Enrollments · 3 rows · payment: waiting for review");
  });

  it("the accountant gets no phone numbers anywhere in the file", async () => {
    const r = await exportAs(accountant);
    expect(r.rows.length).toBe(MANY);
    expect(r.rows.every((x) => x.phone === null)).toBe(true);
    expect(r.payments.every((x) => x.phone === null)).toBe(true);
    expect(r.plan.every((x) => x.phone === null)).toBe(true);
    expect((await audits())[0].actor_id).toBe(accountant.id);
  });

  it("support and sales cannot download, and nothing is logged", async () => {
    const before = (await audits()).length;
    await expectError(exportAs(support), "CRM03");
    await expectError(exportAs(agent), "CRM03");
    expect((await audits()).length).toBe(before);
  });

  it("the normal list is unchanged: one page, no payments, nothing logged", async () => {
    const before = (await audits()).length;
    const r = await as(support, async (q) => (await q<{ r: Exported & { pageSize: number } }>("select public.enrollments_list($1) as r",
      [{ filters: { programIds: [prog] }, scope: "all", sort: { key: "customer", dir: "asc" }, page: 0, pageSize: 100 }]))[0].r);
    expect(r.total).toBe(MANY);
    expect(r.rows.length).toBe(100);
    expect(r.payments).toBeNull();
    expect(r.plan).toBeNull();
    expect((await audits()).length).toBe(before);
  });
});

describe("Leads download log", () => {
  const log = (user: TestUser | null, rows: number) =>
    as(user, (q) => q("select public.log_lead_export($1)", [{ rows, label: "stage: New", filters: { stageKeys: ["new"] }, sort: { key: "created", dir: "desc" } }]));

  it("managers' downloads are recorded with the filters and count", async () => {
    await log(manager, 37);
    const [a] = await audits();
    expect(a).toMatchObject({ actor_id: manager.id, target: "Leads · 37 rows · stage: New" });
    expect(a.details).toMatchObject({ list: "leads", rows: 37, filters: { stageKeys: ["new"] } });
  });

  it("only managers, and never more than 20,000 rows", async () => {
    await expectError(log(accountant, 1), "CRM03");
    await expectError(log(support, 1), "CRM03");
    await expectError(log(agent, 1), "CRM03");
    await expect(log(null, 1)).rejects.toThrow(/permission denied/);
    await expectError(log(manager, 20_001), "CRM01", "20,000");
  });
});
