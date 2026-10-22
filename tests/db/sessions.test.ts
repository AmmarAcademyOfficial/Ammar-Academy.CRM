/**
 * Accounting plan, phase 4 (22 Oct 2026): scheduling and recording teaching sessions, paid and
 * student hours by the rules in Settings, packages and who may do what. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createInquiry, createUser, expectError, type TestUser } from "./helpers";

let manager: TestUser, accountant: TestUser, agent: TestUser, otherAgent: TestUser, support1: TestUser, support2: TestUser;
let prog: string, packCourse: string, groupCourse: string, teacher: string, rate: string;
const PAST = "2026-10-01T15:00:00+03:00";

async function customer(owner: TestUser | null = support1, course = packCourse) {
  const inquiry = (await createInquiry(agent, { program_id: prog })).inquiry_id;
  const enrollment = await as(agent, async (q) => (await q<{ id: string }>("select public.save_enrollment($1) as id",
    [{ inquiry_id: inquiry, course_id: course, agreed_total: 8000 }]))[0].id);
  await admin("insert into public.onboardings (enrollment_id, support_owner_id, claimed_at, status) values ($1, $2, now(), 'onboarding')", [enrollment, owner?.id ?? null]);
  const assignment = (await admin<{ id: string }>(
    "insert into public.teacher_assignments (teacher_id, rate_id, enrollment_id, started_on) values ($1, $2, $3, '2026-09-01') returning id", [teacher, rate, enrollment]))[0].id;
  return { inquiry, enrollment, assignment };
}
const schedule = (user: TestUser, assignment: string, extra: Record<string, unknown> = {}) =>
  as(user, async (q) => (await q<{ n: number }>("select public.schedule_sessions($1) as n", [{ assignment_id: assignment, starts_at: PAST, planned_hours: 2, ...extra }]))[0].n);
const sessionsOf = (assignment: string) =>
  admin<{ id: string; status: string; hours: string | null; paid_hours: string; student_hours: string; late_cancel: boolean; starts_at: Date }>(
    "select id, status, hours::float8::text as hours, paid_hours::float8::text as paid_hours, student_hours::float8::text as student_hours, late_cancel, starts_at from public.teacher_sessions where assignment_id = $1 order by starts_at", [assignment]);
const record = (user: TestUser, id: string, p: Record<string, unknown>) =>
  as(user, async (q) => (await q<{ r: { paid_hours: number; student_hours: number } }>("select public.record_session($1) as r", [{ id, ...p }]))[0].r);

beforeAll(async () => {
  manager = await createUser("manager", "Sess Manager");
  accountant = await createUser("accountant", "Sess Accountant");
  agent = await createUser("sales", "Sess Agent");
  otherAgent = await createUser("sales", "Sess Other Agent");
  support1 = await createUser("support", "Sess Support One");
  support2 = await createUser("support", "Sess Support Two");
  [{ id: prog }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('SESS', 'Session Program') returning id");
  const typeId = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course_type($1) as id", [{ name: "Sess Private", color: "purple" }]))[0].id);
  const mk = (p: Record<string, unknown>) => as(manager, async (q) => (await q<{ id: string }>("select public.save_course($1) as id",
    [{ program_id: prog, course_type_id: typeId, price: 8000, currency: "EGP", delivery: "online", ...p }]))[0].id);
  packCourse = await mk({ name: "Sess 5 x 2h package", sessions_count: 5, session_hours: 2 });
  groupCourse = await mk({ name: "Sess Group" });
  teacher = (await admin<{ id: string }>("insert into public.teachers (full_name) values ('Sess Teacher') returning id"))[0].id;
  rate = (await admin<{ id: string }>("insert into public.teacher_rates (teacher_id, name) values ($1, 'Sess hour') returning id", [teacher]))[0].id;
  await admin("insert into public.teacher_rate_amounts (rate_id, amount, valid_from) values ($1, 400, '2026-01-01')", [rate]);
});
afterAll(async () => {
  await admin("update public.profiles set active = false where id = any($1)", [[accountant.id, agent.id, otherAgent.id, support1.id, support2.id]]);
  await admin("update public.profiles set active = false where id = $1", [manager.id]).catch(() => {});
  await closeDb();
});

describe("scheduling", () => {
  it("the support owner schedules one session or a weekly series; it shows on the timeline", async () => {
    const c = await customer();
    expect(await schedule(support1, c.assignment, { repeat_weeks: 3 })).toBe(4);
    const rows = await sessionsOf(c.assignment);
    expect(rows.map((r) => r.status)).toEqual(["scheduled", "scheduled", "scheduled", "scheduled"]);
    expect((rows[1].starts_at.getTime() - rows[0].starts_at.getTime()) / 86_400_000).toBe(7);
    const [act] = await admin<{ body: string }>("select body from public.activities where inquiry_id = $1 and type = 'session'", [c.inquiry]);
    expect(act.body).toMatch(/^4 weekly sessions scheduled with Sess Teacher: \w{3} 1 Oct, 3:00 PM onwards$/);
  });

  it("checks the length, the series size and the teacher's dates", async () => {
    const c = await customer();
    await expectError(schedule(support1, c.assignment, { planned_hours: 0 }), "CRM01", "0.25 to 12");
    await expectError(schedule(support1, c.assignment, { repeat_weeks: 30 }), "CRM01", "25 more weeks");
    await schedule(support1, c.assignment, { starts_at: "2026-09-15T10:00:00+03:00" });
    await expectError(schedule(support1, c.assignment, { starts_at: "2026-09-08T10:00:00+03:00", repeat_weeks: 2 }), "CRM01", "already a session");
    await expectError(schedule(support1, c.assignment, { starts_at: "2026-08-01T10:00:00+03:00" }), "CRM01", "before this teacher started");
    await admin("update public.teacher_assignments set ended_on = '2026-10-10' where id = $1", [c.assignment]);
    await expectError(schedule(support1, c.assignment, { starts_at: "2026-10-20T10:00:00+03:00" }), "CRM01", "stopped teaching here");
  });

  it("only managers and the support owner, for private customers; the support team for groups", async () => {
    const c = await customer();
    await expectError(schedule(support2, c.assignment), "CRM04", "not assigned to you");
    await expectError(schedule(agent, c.assignment), "CRM03");
    await schedule(manager, c.assignment);
    const g = (await admin<{ id: string }>("insert into public.teacher_assignments (teacher_id, rate_id, course_id, started_on) values ($1, $2, $3, '2026-09-01') returning id", [teacher, rate, groupCourse]))[0].id;
    expect(await schedule(support2, g)).toBe(1);
  });
});

describe("recording", () => {
  it("done counts the real hours for pay and for the package", async () => {
    const c = await customer();
    await schedule(support1, c.assignment);
    const [s] = await sessionsOf(c.assignment);
    expect(await record(support1, s.id, { status: "done", hours: 1.5 })).toEqual({ paid_hours: 1.5, student_hours: 1.5 });
    expect((await sessionsOf(c.assignment))[0]).toMatchObject({ status: "done", hours: "1.5", paid_hours: "1.5", student_hours: "1.5" });
    const acts = await admin<{ body: string }>("select body from public.activities where inquiry_id = $1 and type = 'session' order by created_at desc limit 1", [c.inquiry]);
    expect(acts[0].body).toBe("Session 1 Oct: done, Sess Teacher · 1.5 h paid");
  });

  it("late student cancellations and no-shows are paid by default; in-time and teacher cancellations are not", async () => {
    const c = await customer();
    await schedule(support1, c.assignment, { repeat_weeks: 3 });
    const [a, b, d, e] = await sessionsOf(c.assignment);
    expect(await record(support1, a.id, { status: "cancelled_student", late: true })).toEqual({ paid_hours: 2, student_hours: 2 });
    expect(await record(support1, b.id, { status: "cancelled_student", late: false })).toEqual({ paid_hours: 0, student_hours: 0 });
    expect(await record(support1, d.id, { status: "cancelled_teacher" })).toEqual({ paid_hours: 0, student_hours: 0 });
    expect(await record(support1, e.id, { status: "no_show" })).toEqual({ paid_hours: 2, student_hours: 2 });
    expect((await sessionsOf(c.assignment)).map((s) => s.late_cancel)).toEqual([true, false, false, false]);
  });

  it("the rules come from Settings when recorded, and a later change never rewrites the past", async () => {
    const c = await customer();
    await schedule(support1, c.assignment, { repeat_weeks: 1 });
    const [a, b] = await sessionsOf(c.assignment);
    await record(support1, a.id, { status: "no_show" });
    await as(manager, (q) => q("select public.update_settings($1)", [{ no_show_paid: false, late_cancel_paid: false }]));
    try {
      expect(await record(support1, b.id, { status: "no_show" })).toEqual({ paid_hours: 0, student_hours: 0 });
      expect((await sessionsOf(c.assignment))[0].paid_hours).toBe("2"); // unchanged
    } finally {
      await as(manager, (q) => q("select public.update_settings($1)", [{ no_show_paid: true, late_cancel_paid: true }]));
    }
  });

  it("a future session cannot be recorded; hours are checked; it can be set back to scheduled", async () => {
    const c = await customer();
    await schedule(support1, c.assignment, { starts_at: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    const [s] = await sessionsOf(c.assignment);
    await expectError(record(support1, s.id, { status: "done" }), "CRM01", "has not happened yet");
    await record(support1, s.id, { status: "scheduled", starts_at: PAST, planned_hours: 1 });
    await expectError(record(support1, s.id, { status: "done", hours: 20 }), "CRM01", "up to 12");
    await record(support1, s.id, { status: "done" });
    expect((await sessionsOf(c.assignment))[0]).toMatchObject({ hours: "1", paid_hours: "1" });
    await record(support1, s.id, { status: "scheduled" });
    expect((await sessionsOf(c.assignment))[0]).toMatchObject({ status: "scheduled", paid_hours: "0" });
  });

  it("other people cannot record or remove; a recorded session needs a manager to remove it", async () => {
    const c = await customer();
    await schedule(support1, c.assignment, { repeat_weeks: 1 });
    const [a, b] = await sessionsOf(c.assignment);
    await expectError(record(support2, a.id, { status: "done" }), "CRM04");
    await expectError(record(agent, a.id, { status: "done" }), "CRM03");
    await record(support1, a.id, { status: "done" });
    await expectError(as(support1, (q) => q("select public.delete_session($1)", [a.id])), "CRM01", "only be removed by a manager");
    await as(support1, (q) => q("select public.delete_session($1)", [b.id]));
    await as(manager, (q) => q("select public.delete_session($1)", [a.id]));
    expect(await sessionsOf(c.assignment)).toHaveLength(0);
  });
});

describe("packages and visibility", () => {
  it("support is told once when 2 hours or fewer are left (5 × 2 h package)", async () => {
    const c = await customer();
    await schedule(support1, c.assignment, { repeat_weeks: 4, starts_at: "2026-09-02T15:00:00+03:00" });
    const s = await sessionsOf(c.assignment);
    for (const x of s.slice(0, 3)) await record(support1, x.id, { status: "done" });
    const notes = () => admin<{ text: string }>("select text from public.notifications where inquiry_id = $1 and kind = 'package_low' and user_id = $2", [c.inquiry, support1.id]);
    expect(await notes()).toHaveLength(0); // 4 h left
    await record(support1, s[3].id, { status: "done" });
    const n = await notes();
    expect(n).toHaveLength(1);
    expect(n[0].text).toMatch(/^Package almost used: .+ has 2 of 10 hours left\.$/);
    await record(support1, s[4].id, { status: "done" });
    expect(await notes()).toHaveLength(1);
  });

  it("who sees which sessions", async () => {
    const c = await customer();
    await schedule(support1, c.assignment);
    const view = (u: TestUser) => as(u, (q) => q<{ assignment_id: string; customer_name: string }>("select assignment_id, customer_name from public.sessions_view('2026-10-01', '2026-10-01')"));
    expect((await view(support1)).filter((r) => r.assignment_id === c.assignment)).toHaveLength(1);
    expect((await view(support2)).filter((r) => r.assignment_id === c.assignment)).toHaveLength(0);
    expect((await view(accountant)).filter((r) => r.assignment_id === c.assignment)).toHaveLength(1);
    await expectError(view(agent), "CRM03");
    expect(await as(agent, (q) => q("select 1 from public.teacher_sessions where assignment_id = $1", [c.assignment]))).toHaveLength(1); // the sales owner, read only
    expect(await as(otherAgent, (q) => q("select 1 from public.teacher_sessions where assignment_id = $1", [c.assignment]))).toHaveLength(0);
    await expectError(as(support1, (q) => q("update public.teacher_sessions set paid_hours = 9 where assignment_id = $1", [c.assignment])), "42501");
  });
});

describe("number text", () => {
  it("hours and money keep their decimals", async () => {
    const [r] = await admin<{ h1: string; h2: string; h3: string; m1: string; m2: string; m3: string }>(
      "select private.hours_text(1.5) h1, private.hours_text(2.00) h2, private.hours_text(0.25) h3, private.money(1234.5, 'EGP') m1, private.money(2500, 'EGP') m2, private.money(100.05, 'USD') m3");
    expect(r).toEqual({ h1: "1.5", h2: "2", h3: "0.25", m1: "1,234.5 EGP", m2: "2,500 EGP", m3: "100.05 USD" });
  });
});
