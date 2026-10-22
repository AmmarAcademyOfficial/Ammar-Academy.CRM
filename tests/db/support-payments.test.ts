/**
 * Accounting plan, phase 1 (22 Oct 2026): payment types, support recording payments, payment
 * plans with paid / overdue status, and "due soon" / "overdue" alerts.
 * Own program, agents and customers; timed alerts run in 2021 so no other file's rows qualify.
 * Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createInquiry, createUser, expectError, type TestUser } from "./helpers";

let manager: TestUser, agent: TestUser, support1: TestUser, support2: TestUser, otherAgent: TestUser;
let prog: string, course: string;
const RECEIPT = { path: "receipts/11111111-2222-4333-8444-666666666666.jpg", name: "transfer.jpg", mime: "image/jpeg", size: 1234 };
let refN = 0;
const ref = () => `SPAY-${Date.now()}-${++refN}`;
const cairoToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const plusDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

/** A sale of 10,000 EGP owned by `agent`, handed to support1 (onboarding created directly). */
async function customer(total = 10000, supportOwner: TestUser | null = support1) {
  const inquiry = (await createInquiry(agent, { program_id: prog })).inquiry_id;
  const enrollment = await as(agent, async (q) => (await q<{ id: string }>("select public.save_enrollment($1) as id",
    [{ inquiry_id: inquiry, course_id: course, agreed_total: total, price_note: total === 10000 ? null : "Test price" }]))[0].id);
  await admin("insert into public.onboardings (enrollment_id, support_owner_id, claimed_at, status) values ($1, $2, now(), 'onboarding')",
    [enrollment, supportOwner?.id ?? null]);
  return { inquiry, enrollment };
}
async function pay(enrollment: string, amount: number, user: TestUser, extra: Record<string, unknown> = {}) {
  return as(user, async (q) => (await q<{ id: string }>("select public.submit_payment($1) as id", [{
    enrollment_id: enrollment, amount, paid_on: cairoToday(), method: "instapay", reference: ref(), receipt: RECEIPT, ...extra,
  }]))[0].id);
}
const confirm = (payment: string) => as(manager, (q) => q("select public.decide_payment($1, 'confirmed', null)", [payment]));
const due = (enrollment: string, dueOn: string, amount: number, user: TestUser = support1, id?: string) =>
  as(user, async (q) => (await q<{ id: string }>("select public.save_payment_due($1) as id", [{ id, enrollment_id: enrollment, due_on: dueOn, amount }]))[0].id);
const plan = (enrollment: string, user: TestUser = support1) =>
  as(user, (q) => q<{ id: string; status: string; amount: string; covered: string; due_on: string }>(
    "select id, status, amount::float8::text as amount, covered::float8::text as covered, to_char(due_on, 'YYYY-MM-DD') as due_on from public.payment_dues_view($1)", [enrollment]));
const kindOf = async (payment: string) => (await admin<{ kind: string }>("select kind from public.payments where id = $1", [payment]))[0].kind;

beforeAll(async () => {
  manager = await createUser("manager", "SPay Manager");
  agent = await createUser("sales", "SPay Agent");
  otherAgent = await createUser("sales", "SPay Other Agent");
  support1 = await createUser("support", "SPay Support One");
  support2 = await createUser("support", "SPay Support Two");
  [{ id: prog }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('SPAY', 'Support Pay Program') returning id");
  const typeId = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course_type($1) as id", [{ name: "SPay Private", color: "purple" }]))[0].id);
  course = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course($1) as id",
    [{ program_id: prog, course_type_id: typeId, name: "SPay Course", price: 10000, currency: "EGP", delivery: "online" }]))[0].id);
});
afterAll(async () => {
  await admin("update public.profiles set active = false where id = any($1)", [[agent.id, otherAgent.id, support1.id, support2.id]]);
  await admin("update public.profiles set active = false where id = $1", [manager.id]).catch(() => {}); // fine when it is the last manager
  await closeDb();
});

describe("payment types", () => {
  it("are recorded as chosen; full payment must be the whole remaining balance", async () => {
    const c = await customer();
    const p1 = await pay(c.enrollment, 3000, agent, { kind: "deposit" });
    expect(await kindOf(p1)).toBe("deposit");
    await expectError(pay(c.enrollment, 2000, agent, { kind: "full" }), "CRM01", "whole remaining balance");
    const p2 = await pay(c.enrollment, 7000, agent, { kind: "full" });
    expect(await kindOf(p2)).toBe("full");
    await expectError(pay(c.enrollment, 1, agent, { kind: "bonus" }), "CRM01");
  });

  it("an older screen that sends no type gets one filled in", async () => {
    const c = await customer();
    expect(await kindOf(await pay(c.enrollment, 4000, agent))).toBe("deposit");
    expect(await kindOf(await pay(c.enrollment, 1000, agent))).toBe("installment");
    const whole = await customer(5000);
    expect(await kindOf(await pay(whole.enrollment, 5000, agent))).toBe("full");
  });

  it("the activity says which type was submitted", async () => {
    const c = await customer();
    await pay(c.enrollment, 2500, agent, { kind: "deposit" });
    const [a] = await admin<{ body: string }>("select body from public.activities where inquiry_id = $1 and type = 'payment_submitted'", [c.inquiry]);
    expect(a.body).toMatch(/^Payment submitted \(deposit\): 2,500 EGP · instapay · ref SPAY-/);
  });
});

describe("support records payments", () => {
  it("the customer's support owner can, with the same manager confirmation", async () => {
    const c = await customer();
    const p = await pay(c.enrollment, 2000, support1, { kind: "installment" });
    const [row] = await admin<{ status: string; submitted_by: string }>("select status, submitted_by from public.payments where id = $1", [p]);
    expect(row).toEqual({ status: "pending", submitted_by: support1.id });
    const told = await admin("select 1 from public.notifications where user_id = $1 and inquiry_id = $2 and kind = 'payment_to_review'", [manager.id, c.inquiry]);
    expect(told).toHaveLength(1);
    await confirm(p);
    const back = await admin<{ kind: string }>("select kind from public.notifications where user_id = $1 and inquiry_id = $2 order by created_at desc limit 1", [support1.id, c.inquiry]);
    expect(back[0].kind).toBe("payment_update");
  });

  it("other support staff, and support in the queue, cannot", async () => {
    const c = await customer();
    await expectError(pay(c.enrollment, 1000, support2), "CRM04", "not assigned to you");
    const queued = await customer(10000, null);
    await expectError(pay(queued.enrollment, 1000, support1), "CRM04");
    await expectError(pay(c.enrollment, 1000, otherAgent), "CRM04");
  });

  it("support still cannot confirm payments", async () => {
    const c = await customer();
    const p = await pay(c.enrollment, 1000, support1);
    await expectError(as(support1, (q) => q("select public.decide_payment($1, 'confirmed', null)", [p])), "CRM03");
  });
});

describe("payment plan", () => {
  it("payments recorded after the plan count toward it, earliest due first", async () => {
    const c = await customer();
    await confirm(await pay(c.enrollment, 4000, agent, { kind: "deposit" })); // before the plan: not counted toward it
    const today = cairoToday();
    const d1 = await due(c.enrollment, plusDays(today, 10), 3000);
    const d2 = await due(c.enrollment, plusDays(today, 40), 3000);
    expect((await plan(c.enrollment)).map((x) => [x.id, x.status, x.covered])).toEqual([[d1, "upcoming", "0"], [d2, "upcoming", "0"]]);

    await confirm(await pay(c.enrollment, 2000, support1));
    expect((await plan(c.enrollment)).map((x) => [x.status, x.covered])).toEqual([["partly_paid", "2000"], ["upcoming", "0"]]);
    await confirm(await pay(c.enrollment, 2500, support1));
    expect((await plan(c.enrollment)).map((x) => [x.status, x.covered])).toEqual([["paid", "3000"], ["partly_paid", "1500"]]);
  });

  it("pending payments do not count; a fully paid customer's plan is paid", async () => {
    const c = await customer();
    const today = cairoToday();
    await due(c.enrollment, plusDays(today, 5), 6000);
    const p = await pay(c.enrollment, 6000, support1);
    expect((await plan(c.enrollment))[0].status).toBe("upcoming");
    await confirm(p);
    expect((await plan(c.enrollment))[0].status).toBe("paid");

    const full = await customer(3000);
    await confirm(await pay(full.enrollment, 3000, agent));
    await admin("insert into public.payment_dues (enrollment_id, due_on, amount) values ($1, $2, 3000)", [full.enrollment, plusDays(today, -3)]);
    expect((await plan(full.enrollment))[0].status).toBe("paid");
  });

  it("past dues are overdue, today's are due today", async () => {
    const c = await customer();
    const today = cairoToday();
    await due(c.enrollment, plusDays(today, -2), 1000);
    await due(c.enrollment, today, 1000);
    expect((await plan(c.enrollment)).map((x) => x.status)).toEqual(["overdue", "due_today"]);
  });

  it("the plan cannot add up to more than the balance left, and dates stay sensible", async () => {
    const c = await customer(5000);
    await confirm(await pay(c.enrollment, 2000, agent));
    const today = cairoToday();
    await due(c.enrollment, plusDays(today, 7), 2000);
    await expectError(due(c.enrollment, plusDays(today, 14), 1500), "CRM01", "more than the balance left (3,000 EGP)");
    await expectError(due(c.enrollment, plusDays(today, 900), 100), "CRM01", "2 years");
    await expectError(due(c.enrollment, plusDays(today, 7), 0), "CRM01");
    expect(await plan(c.enrollment)).toHaveLength(1); // the refused one was not kept
  });

  it("edit and delete; each change is on the customer's timeline", async () => {
    const c = await customer();
    const today = cairoToday();
    const d = await due(c.enrollment, plusDays(today, 7), 2000);
    await due(c.enrollment, plusDays(today, 9), 2500, support1, d);
    expect((await plan(c.enrollment))[0]).toMatchObject({ id: d, amount: "2500", due_on: plusDays(today, 9) });
    await as(support1, (q) => q("select public.delete_payment_due($1)", [d]));
    expect(await plan(c.enrollment)).toHaveLength(0);
    const acts = await admin<{ body: string }>("select body from public.activities where inquiry_id = $1 and type = 'payment_plan' order by created_at", [c.inquiry]);
    expect(acts.map((a) => a.body.replace(/\d{1,2} \w{3} \d{4}/, "<date>"))).toEqual([
      "Payment plan: 2,000 EGP due <date>", "Payment plan: 2,500 EGP due <date>", "Removed from the payment plan: 2,500 EGP due <date>",
    ]);
  });

  it("only managers and the support owner change the plan; staff who can see the customer can read it", async () => {
    const c = await customer();
    const today = cairoToday();
    const d = await due(c.enrollment, plusDays(today, 7), 1000, manager);
    await expectError(due(c.enrollment, plusDays(today, 8), 1000, support2), "CRM04");
    await expectError(due(c.enrollment, plusDays(today, 8), 1000, agent), "CRM03");
    await expectError(as(support2, (q) => q("select public.delete_payment_due($1)", [d])), "CRM04");
    expect(await plan(c.enrollment, agent)).toHaveLength(1); // the sales owner sees it
    expect(await plan(c.enrollment, otherAgent)).toHaveLength(0); // other agents do not
    expect(await as(otherAgent, (q) => q("select * from public.payment_dues where enrollment_id = $1", [c.enrollment]))).toHaveLength(0);
    await expectError(as(support1, (q) => q("insert into public.payment_dues (enrollment_id, due_on, amount) values ($1, now(), 5)", [c.enrollment])), "42501");
  });
});

describe("payment alerts", () => {
  // Fixed dates in 2021 (Cairo is UTC+2 then): dues inserted directly, alerts run "at" a given time.
  const at = (day: string, hour: number) => `${day}T${String(hour - 2).padStart(2, "0")}:00:00Z`;
  const alerts = async (day: string, hour = 10) =>
    (await admin<{ r: { payments_due_soon: number; payments_overdue: number } }>("select private.send_timed_alerts($1) as r", [at(day, hour)]))[0].r;
  const notes = (user: TestUser, inquiry: string, kind: string) =>
    admin<{ text: string; popup: boolean }>("select text, popup from public.notifications where user_id = $1 and inquiry_id = $2 and kind = $3 order by created_at", [user.id, inquiry, kind]);
  async function dueIn2021(enrollment: string, dueOn: string, amount: number) {
    const [d] = await admin<{ id: string }>("insert into public.payment_dues (enrollment_id, due_on, amount, created_at) values ($1, $2, $3, '2021-01-01') returning id", [enrollment, dueOn, amount]);
    return d.id;
  }

  it("due soon: once, a day before, to the support owner (from 9:00)", async () => {
    const c = await customer();
    await dueIn2021(c.enrollment, "2021-05-10", 2000);
    await alerts("2021-05-08");
    expect(await notes(support1, c.inquiry, "payment_due_soon")).toHaveLength(0);
    await alerts("2021-05-09", 8); // before 9:00
    expect(await notes(support1, c.inquiry, "payment_due_soon")).toHaveLength(0);
    await alerts("2021-05-09", 9);
    await alerts("2021-05-09", 15);
    const n = await notes(support1, c.inquiry, "payment_due_soon");
    expect(n).toHaveLength(1);
    expect(n[0].text).toMatch(/^Payment due soon: \S.* · 2,000 EGP due 10 May\.$/);
    expect(await notes(manager, c.inquiry, "payment_due_soon")).toHaveLength(0);
  });

  it("overdue: the day after, to the support owner and managers, then weekly while unpaid", async () => {
    const c = await customer();
    await dueIn2021(c.enrollment, "2021-06-10", 1500);
    await alerts("2021-06-10", 18);
    expect(await notes(support1, c.inquiry, "payment_overdue")).toHaveLength(0);
    await alerts("2021-06-11");
    const s = await notes(support1, c.inquiry, "payment_overdue");
    expect(s).toHaveLength(1);
    expect(s[0].text).toMatch(/^Payment overdue: \S.* · 1,500 EGP was due 10 Jun \(1 days ago\)\.$/);
    expect(s[0].popup).toBe(true);
    expect(await notes(manager, c.inquiry, "payment_overdue")).toHaveLength(1);
    await alerts("2021-06-15");
    expect(await notes(support1, c.inquiry, "payment_overdue")).toHaveLength(1);
    await alerts("2021-06-18", 11);
    expect(await notes(support1, c.inquiry, "payment_overdue")).toHaveLength(2);
  });

  it("before handover the sales owner is told; paid dues stay quiet", async () => {
    const inquiry = (await createInquiry(agent, { program_id: prog })).inquiry_id;
    const enrollment = await as(agent, async (q) => (await q<{ id: string }>("select public.save_enrollment($1) as id",
      [{ inquiry_id: inquiry, course_id: course, agreed_total: 4000, price_note: "Test price" }]))[0].id);
    await dueIn2021(enrollment, "2021-07-01", 1000);
    await alerts("2021-07-02");
    expect(await notes(agent, inquiry, "payment_overdue")).toHaveLength(1);

    const paid = await customer(1000);
    await confirm(await pay(paid.enrollment, 1000, agent));
    await dueIn2021(paid.enrollment, "2021-07-01", 1000);
    await alerts("2021-07-03");
    expect(await notes(support1, paid.inquiry, "payment_overdue")).toHaveLength(0);
  });

  it("moving a due date sends its alerts again; 0 days turns due-soon off", async () => {
    const c = await customer();
    const id = await dueIn2021(c.enrollment, "2021-08-10", 500);
    await alerts("2021-08-09");
    await admin("update public.payment_dues set due_on = '2021-08-20' where id = $1", [id]);
    await alerts("2021-08-19");
    expect(await notes(support1, c.inquiry, "payment_due_soon")).toHaveLength(2);

    await as(manager, (q) => q("select public.update_settings($1)", [{ payment_due_soon_days: 0 }]));
    try {
      const c2 = await customer();
      await dueIn2021(c2.enrollment, "2021-09-10", 500);
      await alerts("2021-09-09");
      expect(await notes(support1, c2.inquiry, "payment_due_soon")).toHaveLength(0);
    } finally {
      await as(manager, (q) => q("select public.update_settings($1)", [{ payment_due_soon_days: 1 }]));
    }
  });
});
