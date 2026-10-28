/**
 * CRM changes plan 2, Phase 1 (28 Oct 2026): several enrollments per customer, each with its own
 * payments; payments by every role (confirmed at once for managers and the accountant); split
 * transfers; handover on recording, per enrollment, to the customer's current support owner; the
 * accountant reads everything and reviews enrollments without changing leads. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, cairoDate, closeDb, createInquiry, createUser, expectError, type TestUser } from "./helpers";

let manager: TestUser, accountant: TestUser, agent: TestUser, other: TestUser, support1: TestUser, support2: TestUser;
let progA: string, progB: string, courseA1: string, courseA2: string, courseB: string;
const RECEIPT = { path: "receipts/11111111-2222-4333-8444-777777777777.pdf", name: "r.pdf", mime: "application/pdf", size: 900 };
let refN = 0;

const one = async <T,>(user: TestUser, sql: string, params: unknown[]) => as(user, async (q) => (await q<{ r: T }>(sql, params))[0].r);
const enroll = (user: TestUser, p: Record<string, unknown>) => one<string>(user, "select public.save_enrollment($1) as r", [p]);
const pay = (user: TestUser, enrollment: string, amount: number, extra: Record<string, unknown> = {}) =>
  one<string>(user, "select public.submit_payment($1) as r", [{ enrollment_id: enrollment, amount, paid_on: cairoDate(), method: "cash", kind: "installment", ...extra }]);
const status = async (payment: string) => (await admin<{ status: string }>("select status from public.payments where id = $1", [payment]))[0].status;
const onboarding = async (enrollment: string) =>
  (await admin<{ id: string; support_owner_id: string | null; flagged_reason: string | null }>("select id, support_owner_id, flagged_reason from public.onboardings where enrollment_id = $1", [enrollment]))[0];
const queue = (user: TestUser) => one<{ pendingPayments: number; items: { enrollmentId: string; reason: string; priceDiffers: boolean; status: string; additional: boolean }[] }>(user, "select public.review_queue() as r", []);

/** A lead of agent's in program A with a first enrollment on courseA1 (10,000 EGP), handed over to support1. */
async function customer() {
  const inquiry = (await createInquiry(agent, { program_id: progA })).inquiry_id;
  const first = await enroll(agent, { inquiry_id: inquiry, course_id: courseA1, agreed_total: 10000 });
  await pay(agent, first, 3000, { kind: "deposit" }); // 30% rule: hands over at once
  await admin("update public.onboardings set support_owner_id = $2, claimed_at = now() where enrollment_id = $1", [first, support1.id]);
  return { inquiry, first };
}

beforeAll(async () => {
  manager = await createUser("manager", "Multi Manager");
  accountant = await createUser("accountant", "Multi Accountant");
  agent = await createUser("sales", "Multi Agent");
  other = await createUser("sales", "Multi Other Agent");
  support1 = await createUser("support", "Multi Support One");
  support2 = await createUser("support", "Multi Support Two");
  [{ id: progA }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('MULA', 'Multi A') returning id");
  [{ id: progB }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('MULB', 'Multi B') returning id");
  await admin("update public.app_settings set handover_trigger = 'qualifying_deposit', deposit_rule = deposit_rule || jsonb_build_object($1::text, jsonb_build_object('kind', 'percent', 'value', 30), $2::text, jsonb_build_object('kind', 'percent', 'value', 30))", [progA, progB]);
  const typeId = await one<string>(manager, "select public.save_course_type($1) as r", [{ name: "Multi Type", color: "blue" }]);
  const mk = (program: string, name: string, price: number) => one<string>(manager, "select public.save_course($1) as r",
    [{ program_id: program, course_type_id: typeId, name, price, currency: "EGP", delivery: "online" }]);
  courseA1 = await mk(progA, "Multi A Group", 10000);
  courseA2 = await mk(progA, "Multi A Private", 4000);
  courseB = await mk(progB, "Multi B Course", 6000);
});
afterAll(async () => {
  await admin("update public.profiles set active = false where id = any($1)", [[accountant.id, agent.id, other.id, support1.id, support2.id]]);
  await admin("update public.profiles set active = false where id = $1", [manager.id]).catch(() => {});
  await closeDb();
});

describe("several enrollments on one customer", () => {
  it("a second course in the same program has its own total and payments", async () => {
    const c = await customer();
    const second = await enroll(agent, { inquiry_id: c.inquiry, course_id: courseA2, agreed_total: 4000, add: true });
    const rows = await admin<{ id: string; additional: boolean; agreed_total: string }>("select id, additional, agreed_total from public.enrollments where inquiry_id = $1 order by created_at", [c.inquiry]);
    expect(rows.map((r) => [r.additional, r.agreed_total])).toEqual([[false, "10000.00"], [true, "4000.00"]]);
    await pay(agent, second, 1000, { kind: "deposit" });
    // Each enrollment keeps its own balance: 4,000 left on the first is not mixed with the second.
    await expectError(pay(agent, second, 3500), "CRM01", "remaining balance of Multi A Private");
    await pay(agent, c.first, 7000, { kind: "full" });
    const t = await admin<{ id: string; paid: string }>("select e.id, coalesce(sum(p.amount), 0)::text as paid from public.enrollments e left join public.payments p on p.enrollment_id = e.id where e.inquiry_id = $1 group by e.id", [c.inquiry]);
    expect(Object.fromEntries(t.map((r) => [r.id, r.paid]))).toEqual({ [c.first]: "10000.00", [second]: "1000.00" });
  });

  it("a course in another program goes on the same customer; the first enrollment must follow the lead's program", async () => {
    const c = await customer();
    const b = await enroll(agent, { inquiry_id: c.inquiry, course_id: courseB, agreed_total: 6000, add: true });
    expect((await admin<{ n: number }>("select count(*)::int as n from public.enrollments where inquiry_id = $1", [c.inquiry]))[0].n).toBe(2);
    expect(b).toBeTruthy();
    const fresh = (await createInquiry(agent, { program_id: progA })).inquiry_id;
    await expectError(enroll(agent, { inquiry_id: fresh, course_id: courseB, agreed_total: 6000 }), "CRM01", "another program");
  });

  it("changing names the enrollment once there are several; a change goes back to review", async () => {
    const c = await customer();
    const second = await enroll(agent, { inquiry_id: c.inquiry, course_id: courseA2, agreed_total: 4000, add: true });
    await expectError(enroll(agent, { inquiry_id: c.inquiry, course_id: courseA2, agreed_total: 3500, price_note: "Sibling" }), "CRM01", "Choose the one to change");
    await as(manager, (q) => q("select public.review_enrollment($1, 'reviewed', null)", [second]));
    await enroll(agent, { enrollment_id: second, inquiry_id: c.inquiry, course_id: courseA2, agreed_total: 3500, price_note: "Sibling" });
    const [e] = await admin<{ agreed_total: string; review_status: string; review_reason: string }>("select agreed_total, review_status, review_reason from public.enrollments where id = $1", [second]);
    expect(e).toEqual({ agreed_total: "3500.00", review_status: "to_review", review_reason: "Changed" });
  });

  it("credit for a new enrollment can be chosen; support may credit themselves", async () => {
    const c = await customer();
    const e = await enroll(support1, { inquiry_id: c.inquiry, course_id: courseA2, agreed_total: 4000, add: true, sales_agent_id: support1.id });
    expect((await admin<{ o: string }>("select original_sales_owner_id as o from public.enrollments where id = $1", [e]))[0].o).toBe(support1.id);
    await expectError(enroll(support1, { inquiry_id: c.inquiry, course_id: courseA2, agreed_total: 4000, add: true, sales_agent_id: accountant.id }), "CRM01", "credited");
    // Support of another customer, and other sales agents, cannot.
    await expectError(enroll(support2, { inquiry_id: c.inquiry, course_id: courseA2, agreed_total: 4000, add: true }), "CRM04");
    await expectError(enroll(other, { inquiry_id: c.inquiry, course_id: courseA2, agreed_total: 4000, add: true }), "CRM04");
  });
});

describe("handover per enrollment", () => {
  it("a second enrollment goes straight to the customer's support owner, who alone is told", async () => {
    const c = await customer();
    const second = await enroll(agent, { inquiry_id: c.inquiry, course_id: courseA2, agreed_total: 4000, add: true });
    expect(await onboarding(second)).toBeUndefined();
    await pay(agent, second, 1200, { kind: "deposit" }); // waiting for review, but meets the 30% rule
    expect((await onboarding(second)).support_owner_id).toBe(support1.id);
    const told = await admin<{ user_id: string }>("select user_id from public.notifications where inquiry_id = $1 and text like 'New course for your customer%'", [c.inquiry]);
    expect(told.map((t) => t.user_id)).toEqual([support1.id]);
    expect(await admin("select 1 from public.notifications where inquiry_id = $1 and text like 'New customer ready%' and text like '%Multi A Private%'", [c.inquiry])).toHaveLength(0);
  });

  it("a rejected payment that drops below the rule flags the customer; a confirmed one later clears it", async () => {
    const inquiry = (await createInquiry(agent, { program_id: progA })).inquiry_id;
    const e = await enroll(agent, { inquiry_id: inquiry, course_id: courseA1, agreed_total: 10000 });
    const p = await pay(agent, e, 3000, { kind: "deposit" });
    expect(await onboarding(e)).toBeTruthy();
    const r = await one<{ flagged: boolean }>(accountant, "select public.decide_payment($1, 'rejected', 'Transfer not received') as r", [p]);
    expect(r.flagged).toBe(true);
    expect((await onboarding(e)).flagged_reason).toMatch(/^A payment of 3,000 EGP was rejected \(Transfer not received\)/);
    await pay(manager, e, 3000, { kind: "deposit" }); // a manager's payment is confirmed at once
    expect((await onboarding(e)).flagged_reason).toBeNull();
  });
});

describe("payments by every role", () => {
  it("managers' and the accountant's payments are confirmed at once; sales and support wait for review", async () => {
    const c = await customer();
    const a = await pay(accountant, c.first, 500);
    const m = await pay(manager, c.first, 500);
    const s = await pay(support1, c.first, 500);
    const g = await pay(agent, c.first, 500);
    expect([await status(a), await status(m), await status(s), await status(g)]).toEqual(["confirmed", "confirmed", "pending", "pending"]);
    const [x] = await admin<{ decided_by: string }>("select decided_by from public.payments where id = $1", [a]);
    expect(x.decided_by).toBe(accountant.id);
    const told = await admin("select 1 from public.notifications where user_id = $1 and inquiry_id = $2 and text like 'Payment to review: %Multi A Group%'", [accountant.id, c.inquiry]);
    expect(told.length).toBe(3); // the first deposit, then the support and sales payments, each naming the course
  });

  it("one transfer split across two courses: one reference, one receipt; duplicates elsewhere are still refused", async () => {
    const c = await customer();
    const second = await enroll(agent, { inquiry_id: c.inquiry, course_id: courseA2, agreed_total: 4000, add: true });
    const ref = `MULTI-SPLIT-${++refN}-${Date.now()}`;
    const r = await one<{ ids: string[]; split_group: string }>(agent, "select public.submit_split_payment($1) as r", [{
      parts: [{ enrollment_id: c.first, amount: 2000, kind: "installment" }, { enrollment_id: second, amount: 1500, kind: "deposit" }],
      paid_on: cairoDate(), method: "instapay", reference: ref, receipt: RECEIPT }]);
    const rows = await admin<{ reference: string; split_group: string; receipt_path: string }>("select reference, split_group, receipt_path from public.payments where id = any($1)", [r.ids]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((x) => `${x.reference}|${x.split_group}|${x.receipt_path}`)).size).toBe(1);
    // The same reference again, on another customer, is a duplicate.
    const d = await customer();
    await expectError(pay(agent, d.first, 100, { method: "instapay", reference: ref, receipt: RECEIPT }), "CRM01", "already submitted");
  });

  it("a split is all or nothing, for one customer only", async () => {
    const c = await customer();
    const second = await enroll(agent, { inquiry_id: c.inquiry, course_id: courseA2, agreed_total: 4000, add: true });
    const before = (await admin<{ n: number }>("select count(*)::int as n from public.payments where enrollment_id = any($1)", [[c.first, second]]))[0].n;
    await expectError(one(agent, "select public.submit_split_payment($1) as r", [{
      parts: [{ enrollment_id: c.first, amount: 1000, kind: "installment" }, { enrollment_id: second, amount: 9999, kind: "installment" }],
      paid_on: cairoDate(), method: "cash" }]), "CRM01", "remaining balance");
    expect((await admin<{ n: number }>("select count(*)::int as n from public.payments where enrollment_id = any($1)", [[c.first, second]]))[0].n).toBe(before);
    const d = await customer();
    await expectError(one(manager, "select public.submit_split_payment($1) as r", [{
      parts: [{ enrollment_id: c.first, amount: 100, kind: "installment" }, { enrollment_id: d.first, amount: 100, kind: "installment" }],
      paid_on: cairoDate(), method: "cash" }]), "CRM01", "one customer");
  });
});

describe("the accountant sees everything and reviews it", () => {
  it("reads leads and records payments but changes no lead, enrollment or note", async () => {
    const c = await customer();
    expect(await as(accountant, (q) => q("select 1 from public.inquiries where id = $1", [c.inquiry]))).toHaveLength(1);
    await expectError(enroll(accountant, { inquiry_id: c.inquiry, course_id: courseA2, agreed_total: 4000, add: true }), "CRM03");
    await expectError(as(accountant, (q) => q("select public.add_note($1, 'Hello')", [c.inquiry])), "CRM03");
    await expectError(as(accountant, (q) => q("select public.create_follow_up($1, now() + interval '1 day', 'x')", [c.inquiry])), "CRM03");
  });

  it("new, additional and changed enrollments wait for review; nothing waits for the review", async () => {
    const c = await customer();
    const second = await enroll(agent, { inquiry_id: c.inquiry, course_id: courseA2, agreed_total: 3000, price_note: "Returning student", add: true });
    const q1 = await queue(accountant);
    const item = q1.items.find((x) => x.enrollmentId === second)!;
    expect(item).toMatchObject({ reason: "Additional enrollment", priceDiffers: true, status: "to_review", additional: true });
    expect(q1.items.some((x) => x.enrollmentId === c.first)).toBe(true);
    // Payments and handover go ahead while it waits.
    await pay(agent, second, 900, { kind: "deposit" });
    expect(await onboarding(second)).toBeTruthy();
    await as(accountant, (q) => q("select public.review_enrollment($1, 'reviewed', null)", [c.first]));
    expect((await queue(accountant)).items.some((x) => x.enrollmentId === c.first)).toBe(false);
  });

  it("a query needs a note and tells who entered it, who is credited and the managers", async () => {
    const c = await customer();
    await expectError(as(accountant, (q) => q("select public.review_enrollment($1, 'queried', '')", [c.first])), "CRM01", "Write what needs checking");
    await as(accountant, (q) => q("select public.review_enrollment($1, 'queried', 'Discount not approved?')", [c.first]));
    const told = await admin<{ user_id: string }>("select user_id from public.notifications where inquiry_id = $1 and text like 'Enrollment queried by Multi Accountant:%Discount not approved?'", [c.inquiry]);
    const ids = told.map((t) => t.user_id);
    expect(ids).toContain(agent.id);
    expect(ids).toContain(manager.id);
    expect(ids).not.toContain(accountant.id);
    expect((await queue(manager)).items.find((x) => x.enrollmentId === c.first)?.status).toBe("queried");
    const [a] = await admin<{ action: string }>("select action from public.audit_log where actor_id = $1 order by created_at desc limit 1", [accountant.id]);
    expect(a.action).toBe("Queried enrollment: Multi A Group · Discount not approved?");
  });

  it("only managers and the accountant review", async () => {
    const c = await customer();
    await expectError(queue(support1), "CRM03");
    await expectError(as(agent, (q) => q("select public.review_enrollment($1, 'reviewed', null)", [c.first])), "CRM03");
  });
});

describe("add existing customer keeps one record per student", () => {
  it("the same person and student get the new course on their existing record", async () => {
    const c = await customer();
    const [{ contact_id: contactId, student_name: student }] = await admin<{ contact_id: string; student_name: string | null }>("select contact_id, student_name from public.inquiries where id = $1", [c.inquiry]);
    const r = await one<{ inquiry_id: string; additional: boolean }>(manager, "select public.add_existing_customer($1) as r", [{
      contact_id: contactId, student_name: student, program_id: progB, course_id: courseB, agreed_total: 6000, support_owner_id: support2.id }]);
    expect(r).toMatchObject({ inquiry_id: c.inquiry, additional: true });
    const [e] = await admin<{ added_as_existing: boolean; review_reason: string }>("select added_as_existing, review_reason from public.enrollments where inquiry_id = $1 and course_id = $2", [c.inquiry, courseB]);
    expect(e).toEqual({ added_as_existing: true, review_reason: "Added as existing customer" });
  });
});
