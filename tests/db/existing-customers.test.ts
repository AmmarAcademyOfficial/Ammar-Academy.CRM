/**
 * CRM changes, Part D (26 Oct 2026): support and managers add an existing customer with their
 * enrollment, past payments, plan, onboarding and teacher in one step. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createUser, expectError, newPhone, type TestUser } from "./helpers";

let manager: TestUser, accountant: TestUser, support: TestUser, support2: TestUser, agent: TestUser;
let prog: string, course: string, teacher: string, rate: string;

const add = (user: TestUser, p: Record<string, unknown>) =>
  as(user, async (q) => (await q<{ r: { inquiry_id: string; enrollment_id: string; contact_id: string; confirmed: number; pending: number; planned: number } }>(
    "select public.add_existing_customer($1) as r", [p]))[0].r);
const base = (extra: Record<string, unknown> = {}) => {
  const phone = newPhone();
  return { name: `Existing ${phone.slice(-4)}`, phone, phone_normalized: phone, contact_type: "parent", student_name: "Omar",
    program_id: prog, course_id: course, agreed_total: 9000, enrolled_on: "2026-08-15", ...extra };
};
const list = (user: TestUser, filters: Record<string, unknown> = {}) =>
  as(user, async (q) => (await q<{ r: { total: number; rows: { customerName: string; paid: number; balance: number; status: string; supportOwnerId: string | null; packageUsed: number | null; overdueLeft: number; nextDueOn: string | null }[] } }>(
    "select public.enrollments_list($1) as r", [{ filters: { programIds: [prog], ...filters } }]))[0].r);

beforeAll(async () => {
  manager = await createUser("manager", "Exist Manager");
  accountant = await createUser("accountant", "Exist Accountant");
  support = await createUser("support", "Exist Support");
  support2 = await createUser("support", "Exist Support Two");
  agent = await createUser("sales", "Exist Agent");
  [{ id: prog }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('EXST', 'Existing Program') returning id");
  const typeId = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course_type($1) as id", [{ name: "Exist Private", color: "purple" }]))[0].id);
  course = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course($1) as id",
    [{ program_id: prog, course_type_id: typeId, name: "Exist 10 x 2h", price: 9000, currency: "EGP", delivery: "online", sessions_count: 10, session_hours: 2 }]))[0].id);
  teacher = (await admin<{ id: string }>("insert into public.teachers (full_name) values ('Exist Teacher') returning id"))[0].id;
  rate = (await admin<{ id: string }>("insert into public.teacher_rates (teacher_id, name) values ($1, 'Private') returning id", [teacher]))[0].id;
});
afterAll(async () => {
  await admin("update public.profiles set active = false where id = any($1)", [[accountant.id, support.id, support2.id, agent.id]]);
  await admin("update public.profiles set active = false where id = $1", [manager.id]).catch(() => {});
  await closeDb();
});

describe("adding an existing customer", () => {
  it("a manager adds everything in one step; past payments are confirmed and the plan covers only what is left", async () => {
    const p = base({
      sales_agent_id: agent.id, support_owner_id: support.id, status: "active", package_hours_before: 6,
      payments: [
        { amount: 3000, paid_on: "2026-08-15", method: "instapay", kind: "deposit", reference: `EX-${Date.now()}` },
        { amount: 2000, paid_on: "2026-09-15", method: "cash", kind: "installment" },
      ],
      dues: [{ due_on: "2026-10-15", amount: 2000 }, { due_on: "2027-01-15", amount: 2000 }],
      teacher: { teacher_id: teacher, rate_id: rate, subject: "Math" },
    });
    await admin("delete from public.notifications where user_id = any($1)", [[manager.id, support.id, agent.id]]);
    const r = await add(manager, p);
    expect([r.confirmed, r.pending, r.planned]).toEqual([5000, 0, 4000]);

    const [i] = await admin<{ stage: string; added_as_existing: boolean; sales_owner_id: string; owner_opened_at: Date | null }>(
      "select s.system_key as stage, i.added_as_existing, i.sales_owner_id, i.owner_opened_at from public.inquiries i join public.stages s on s.id = i.stage_id where i.id = $1", [r.inquiry_id]);
    expect([i.stage, i.added_as_existing, i.sales_owner_id]).toEqual(["enrolled", true, agent.id]);
    expect(i.owner_opened_at).not.toBeNull();
    const [e] = await admin<{ enrolled: string; original_sales_owner_id: string; currency: string }>(
      "select to_char(created_at at time zone 'Africa/Cairo', 'YYYY-MM-DD') as enrolled, original_sales_owner_id, currency from public.enrollments where id = $1", [r.enrollment_id]);
    expect(e).toEqual({ enrolled: "2026-08-15", original_sales_owner_id: agent.id, currency: "EGP" });
    const pays = await admin<{ status: string; paid_on: string }>("select status, to_char(paid_on, 'YYYY-MM-DD') as paid_on from public.payments where enrollment_id = $1 order by paid_on", [r.enrollment_id]);
    expect(pays).toEqual([{ status: "confirmed", paid_on: "2026-08-15" }, { status: "confirmed", paid_on: "2026-09-15" }]);

    // The plan is only what is left: the October due is overdue, not covered by the old payments.
    const [row] = (await list(manager, { search: p.name })).rows;
    expect(row).toMatchObject({ paid: 5000, balance: 4000, status: "active", supportOwnerId: support.id, overdueLeft: 2000, packageUsed: 6 });
    const [ob] = await admin<{ done: number; total: number }>(
      "select count(*) filter (where done_at is not null)::int as done, count(*)::int as total from public.onboarding_items oi join public.onboardings o on o.id = oi.onboarding_id where o.enrollment_id = $1", [r.enrollment_id]);
    expect(ob.done).toBe(ob.total); // active: the checklist is complete
    const [a] = await admin<{ n: number }>("select count(*)::int as n from public.teacher_assignments where enrollment_id = $1 and teacher_id = $2", [r.enrollment_id, teacher]);
    expect(a.n).toBe(1);

    // No new-lead alerts; the support owner is told.
    expect((await admin("select 1 from public.notifications where user_id = $1 and kind = 'new_lead'", [manager.id])).length).toBe(0);
    expect((await admin<{ text: string }>("select text from public.notifications where user_id = $1", [support.id])).map((n) => n.text)).toEqual([`Customer assigned to you for onboarding: ${p.name}`]);
    const acts = await admin<{ body: string }>("select body from public.activities where inquiry_id = $1 order by created_at", [r.inquiry_id]);
    expect(acts.some((x) => x.body.startsWith("Added as an existing customer by Exist Manager: Exist 10 x 2h"))).toBe(true);
    const [audit] = await admin<{ n: number }>("select count(*)::int as n from public.audit_log where action like 'Added existing customer:%' and target = $1", [p.name]);
    expect(audit.n).toBe(1);
  });

  it("support's past payments go to review, and the customer is theirs by default", async () => {
    const p = base({ payments: [{ amount: 1000, paid_on: "2026-09-01", method: "cash", kind: "deposit" }] });
    await admin("delete from public.notifications where user_id = $1", [accountant.id]);
    const r = await add(support, p);
    expect([r.confirmed, r.pending]).toEqual([0, 1000]);
    const [row] = (await list(manager, { search: p.name })).rows;
    expect(row).toMatchObject({ paid: 0, supportOwnerId: support.id, status: "onboarding" });
    expect((await admin<{ text: string }>("select text from public.notifications where user_id = $1", [accountant.id])).map((n) => n.text))
      .toEqual([`Payment to review: ${p.name} · 1,000 EGP`]);
    // Confirming it later does not hand over a second time.
    const [pay] = await admin<{ id: string }>("select id from public.payments where enrollment_id = $1", [r.enrollment_id]);
    await as(manager, (q) => q("select public.decide_payment($1, 'confirmed')", [pay.id]));
    const [n] = await admin<{ n: number }>("select count(*)::int as n from public.onboardings where enrollment_id = $1", [r.enrollment_id]);
    expect(n.n).toBe(1);
  });

  it("adds a second enrollment to a person already in the CRM", async () => {
    const first = await add(manager, base());
    const [{ name }] = await admin<{ name: string }>("select name from public.contacts where id = $1", [first.contact_id]);
    const phone = (await admin<{ phone_normalized: string }>("select phone_normalized from public.contacts where id = $1", [first.contact_id]))[0].phone_normalized;
    const found = await as(support, async (q) => (await q<{ r: { contactId: string; name: string; inquiries: unknown[] } | null }>("select public.lookup_contact_by_phone($1) as r", [phone]))[0].r);
    expect([found?.contactId, found?.name, found?.inquiries.length]).toEqual([first.contact_id, name, 1]);
    await expectError(add(manager, base({ phone, phone_normalized: phone })), "CRM01", "already in the CRM");
    const second = await add(manager, { contact_id: first.contact_id, program_id: prog, course_id: course, agreed_total: 9000, student_name: "Laila" });
    const [c] = await admin<{ n: number }>("select count(*)::int as n from public.inquiries where contact_id = $1", [first.contact_id]);
    expect([second.contact_id, c.n]).toEqual([first.contact_id, 2]);
    await expectError(add(manager, { contact_id: first.contact_id, program_id: prog, course_id: course, agreed_total: 9000, student_name: "Laila" }), "CRM01", "already enrolled in this course");
  });

  it("checks amounts, dates and choices, and saves nothing when one part is wrong", async () => {
    const p = base();
    await expectError(add(manager, { ...p, agreed_total: 8000 }), "CRM01", "differs from the course price");
    await expectError(add(manager, { ...p, payments: [{ amount: 6000, paid_on: "2026-09-01", method: "cash", kind: "deposit" }, { amount: 4000, paid_on: "2026-09-02", method: "cash", kind: "installment" }] }), "CRM01", "more than the agreed total");
    await expectError(add(manager, { ...p, payments: [{ amount: 1000, paid_on: "2026-09-01", method: "cash", kind: "deposit" }], dues: [{ due_on: "2026-12-01", amount: 9000 }] }), "CRM01", "more than what is left");
    await expectError(add(manager, { ...p, payments: [{ amount: 1000, paid_on: "2099-01-01", method: "cash", kind: "deposit" }] }), "CRM01", "future");
    await expectError(add(manager, { ...p, enrolled_on: "2099-01-01" }), "CRM01", "future");
    await expectError(add(manager, { ...p, support_owner_id: agent.id }), "CRM01", "active support agent");
    await expectError(add(manager, { ...p, teacher: { teacher_id: teacher, rate_id: "00000000-0000-4000-8000-000000000000" } }), "CRM01", "teacher's rates");
    const [c] = await admin<{ n: number }>("select count(*)::int as n from public.contacts where phone_normalized = $1", [p.phone_normalized]);
    expect(c.n).toBe(0); // all or nothing
  });

  it("only managers and support add existing customers", async () => {
    await expectError(add(agent, base()), "CRM03");
    await expectError(add(accountant, base()), "CRM03");
    await expectError(as(agent, (q) => q("select public.lookup_contact_by_phone('+201000000000')")), "CRM03");
  });

  it("Reports do not count them as new inquiries or enrollments", async () => {
    const before = await as(manager, async (q) => (await q<{ r: { newInquiries: number; enrollments: number } }>("select public.report($1) as r",
      [{ from: "2026-01-01", to: "2027-12-31", program_id: prog }]))[0].r);
    await add(manager, base());
    const after = await as(manager, async (q) => (await q<{ r: { newInquiries: number; enrollments: number } }>("select public.report($1) as r",
      [{ from: "2026-01-01", to: "2027-12-31", program_id: prog }]))[0].r);
    expect([after.newInquiries, after.enrollments]).toEqual([before.newInquiries, before.enrollments]);
  });
});
