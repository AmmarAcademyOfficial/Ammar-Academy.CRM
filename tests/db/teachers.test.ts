/**
 * Accounting plan, phase 3 (22 Oct 2026): teachers, hourly rates with dated amounts, and teacher
 * assignments to private customers and group courses. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createInquiry, createUser, expectError, type TestUser } from "./helpers";

let manager: TestUser, accountant: TestUser, agent: TestUser, support1: TestUser, support2: TestUser;
let prog: string, course: string, groupCourse: string;
let n = 0;

async function teacher(name = `Teacher ${Date.now()}-${++n}`, extra: Record<string, unknown> = {}) {
  return as(manager, async (q) => (await q<{ id: string }>("select public.save_teacher($1) as id", [{ full_name: name, program_ids: [prog], ...extra }]))[0].id);
}
async function rate(teacherId: string, name: string, amount: number, validFrom = "2026-10-26", currency = "EGP") {
  return as(manager, async (q) => (await q<{ id: string }>("select public.add_teacher_rate($1) as id", [{ teacher_id: teacherId, name, amount, valid_from: validFrom, currency }]))[0].id);
}
async function customer(supportOwner: TestUser | null = support1) {
  const inquiry = (await createInquiry(agent, { program_id: prog })).inquiry_id;
  const enrollment = await as(agent, async (q) => (await q<{ id: string }>("select public.save_enrollment($1) as id",
    [{ inquiry_id: inquiry, course_id: course, agreed_total: 10000 }]))[0].id);
  await admin("insert into public.onboardings (enrollment_id, support_owner_id, claimed_at, status) values ($1, $2, now(), 'onboarding')", [enrollment, supportOwner?.id ?? null]);
  return { inquiry, enrollment };
}
const assign = (user: TestUser, p: Record<string, unknown>) =>
  as(user, async (q) => (await q<{ id: string }>("select public.assign_teacher($1) as id", [p]))[0].id);
const amountOn = async (rateId: string, day: string) =>
  (await admin<{ a: string | null }>("select private.rate_amount_on($1, $2)::text as a", [rateId, day]))[0].a;

beforeAll(async () => {
  manager = await createUser("manager", "Teach Manager");
  accountant = await createUser("accountant", "Teach Accountant");
  agent = await createUser("sales", "Teach Agent");
  support1 = await createUser("support", "Teach Support One");
  support2 = await createUser("support", "Teach Support Two");
  [{ id: prog }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('TCHR', 'Teacher Program') returning id");
  const typeId = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course_type($1) as id", [{ name: "Teach Private", color: "purple" }]))[0].id);
  const mk = (name: string) => as(manager, async (q) => (await q<{ id: string }>("select public.save_course($1) as id",
    [{ program_id: prog, course_type_id: typeId, name, price: 10000, currency: "EGP", delivery: "online" }]))[0].id);
  course = await mk("Teach Private Course");
  groupCourse = await mk("Teach Group Course");
});
afterAll(async () => {
  await admin("update public.profiles set active = false where id = any($1)", [[accountant.id, agent.id, support1.id, support2.id]]);
  await admin("update public.profiles set active = false where id = $1", [manager.id]).catch(() => {});
  await closeDb();
});

describe("teachers", () => {
  it("managers add and edit teachers; names are unique; changes are audited", async () => {
    const id = await teacher("Teach Ahmed Sample", { phone: "+201000000001", notes: "Math" });
    await as(manager, (q) => q("select public.save_teacher($1)", [{ id, full_name: "Teach Ahmed Sample", program_ids: [prog], active: false }]));
    expect((await admin<{ active: boolean }>("select active from public.teachers where id = $1", [id]))[0].active).toBe(false);
    await expectError(teacher("teach ahmed sample"), "CRM01", "already exists");
    await expectError(as(manager, (q) => q("select public.save_teacher($1)", [{ full_name: " " }])), "CRM01", "name");
    await expectError(as(support1, (q) => q("select public.save_teacher($1)", [{ full_name: "Nope" }])), "CRM03");
    const audit = await admin<{ action: string }>("select action from public.audit_log where target = 'Teach Ahmed Sample' order by created_at");
    expect(audit.map((a) => a.action)).toEqual(["Added teacher", "Updated teacher"]);
  });
});

describe("hourly rates", () => {
  it("one teacher, several rates; a new amount applies from its date and never rewrites the past", async () => {
    const t = await teacher();
    const priv = await rate(t, "SAT private", 400);
    const grp = await rate(t, "SAT group", 600);
    expect(await amountOn(priv, "2026-10-25")).toBeNull(); // before its first amount
    expect(await amountOn(priv, "2026-11-10")).toBe("400.00");
    await as(manager, (q) => q("select public.set_teacher_rate_amount($1, 450, '2026-11-26')", [priv]));
    expect(await amountOn(priv, "2026-11-25")).toBe("400.00");
    expect(await amountOn(priv, "2026-11-26")).toBe("450.00");
    expect(await amountOn(grp, "2026-12-01")).toBe("600.00");
    // Same date again = a correction of that amount.
    await as(manager, (q) => q("select public.set_teacher_rate_amount($1, 460, '2026-11-26')", [priv]));
    expect(await amountOn(priv, "2026-11-30")).toBe("460.00");
    expect((await admin("select 1 from public.teacher_rate_amounts where rate_id = $1", [priv])).length).toBe(2);
    const audit = await admin<{ action: string }>("select action from public.audit_log where action like 'Rate SAT private:%' order by created_at desc limit 1");
    expect(audit[0].action).toBe("Rate SAT private: 460 EGP per hour from 26 Nov 2026");
  });

  it("are validated, named once per teacher, and archived instead of deleted", async () => {
    const t = await teacher();
    const r = await rate(t, "IELTS private", 500, "2026-10-26", "USD");
    await expectError(rate(t, "ielts PRIVATE", 300), "CRM01", "already has a rate");
    await expectError(rate(t, "Zero", 0), "CRM01", "amount per hour");
    await expectError(rate(t, "Bad currency", 10, "2026-10-26", "egypt"), "CRM01", "3-letter");
    await as(manager, (q) => q("select public.set_teacher_rate_archived($1, true)", [r]));
    expect((await admin<{ archived: boolean; currency: string }>("select archived, currency from public.teacher_rates where id = $1", [r]))[0]).toEqual({ archived: true, currency: "USD" });
    await expectError(as(support1, (q) => q("select public.set_teacher_rate_amount($1, 1, current_date)", [r])), "CRM03");
  });

  it("amounts are visible to managers and accountants only; names to everyone", async () => {
    const t = await teacher();
    const r = await rate(t, "Visible rate", 350);
    for (const u of [manager, accountant]) expect(await as(u, (q) => q("select amount from public.teacher_rate_amounts where rate_id = $1", [r]))).toHaveLength(1);
    for (const u of [agent, support1]) {
      expect(await as(u, (q) => q("select amount from public.teacher_rate_amounts where rate_id = $1", [r]))).toHaveLength(0);
      expect(await as(u, (q) => q<{ name: string }>("select name from public.teacher_rates where id = $1", [r]))).toEqual([{ name: "Visible rate" }]);
    }
    await expectError(as(null, (q) => q("select * from public.teachers")), "42501");
  });
});

describe("assignments", () => {
  it("the support owner assigns a private teacher with one of the teacher's rates; it shows on the timeline", async () => {
    const t = await teacher("Teach Private Teacher");
    const r = await rate(t, "Private hour", 400);
    const c = await customer();
    const a = await assign(support1, { teacher_id: t, rate_id: r, enrollment_id: c.enrollment, subject: "Math" });
    const row = (await admin<{ teacher_id: string; rate_id: string; enrollment_id: string; subject: string }>(
      "select teacher_id, rate_id, enrollment_id, subject from public.teacher_assignments where id = $1", [a]))[0];
    expect(row).toEqual({ teacher_id: t, rate_id: r, enrollment_id: c.enrollment, subject: "Math" });
    const [act] = await admin<{ body: string }>("select body from public.activities where inquiry_id = $1 and type = 'teacher'", [c.inquiry]);
    expect(act.body).toMatch(/^Teacher: Teach Private Teacher · Math \(Private hour\) from \d{1,2} \w{3} \d{4}$/);
    // A second subject with another teacher is fine; the same teacher and subject twice is not.
    await expectError(assign(support1, { teacher_id: t, rate_id: r, enrollment_id: c.enrollment, subject: "Math" }), "CRM01", "already teaches");
    const t2 = await teacher();
    const r2 = await rate(t2, "Reading hour", 380);
    await assign(support1, { teacher_id: t2, rate_id: r2, enrollment_id: c.enrollment, subject: "Reading" });
    expect(await as(agent, (q) => q("select 1 from public.teacher_assignments where enrollment_id = $1", [c.enrollment]))).toHaveLength(2); // the sales owner sees them
  });

  it("refuses another teacher's rate, archived rates, inactive teachers, and other people's customers", async () => {
    const t = await teacher();
    const r = await rate(t, "Mine", 400);
    const other = await teacher();
    const otherRate = await rate(other, "Theirs", 400);
    const c = await customer();
    await expectError(assign(support1, { teacher_id: t, rate_id: otherRate, enrollment_id: c.enrollment }), "CRM01", "this teacher's rates");
    await expectError(assign(support2, { teacher_id: t, rate_id: r, enrollment_id: c.enrollment }), "CRM04", "not assigned to you");
    await expectError(assign(agent, { teacher_id: t, rate_id: r, enrollment_id: c.enrollment }), "CRM03");
    await as(manager, (q) => q("select public.set_teacher_rate_archived($1, true)", [r]));
    await expectError(assign(manager, { teacher_id: t, rate_id: r, enrollment_id: c.enrollment }), "CRM01", "archived");
    const sleeper = await teacher(undefined, { active: false });
    const sr = await rate(sleeper, "Any", 100);
    await expectError(assign(manager, { teacher_id: sleeper, rate_id: sr, enrollment_id: c.enrollment }), "CRM01", "not an active teacher");
  });

  it("group courses: managers only; every staff member sees who teaches the group", async () => {
    const t = await teacher();
    const r = await rate(t, "Group hour", 600);
    await expectError(assign(support1, { teacher_id: t, rate_id: r, course_id: groupCourse }), "CRM03");
    const a = await assign(manager, { teacher_id: t, rate_id: r, course_id: groupCourse });
    for (const u of [agent, support2, accountant]) expect(await as(u, (q) => q("select 1 from public.teacher_assignments where id = $1", [a]))).toHaveLength(1);
    await expectError(assign(manager, { teacher_id: t, rate_id: r, course_id: groupCourse, enrollment_id: (await customer()).enrollment }), "CRM01", "customer or a group");
  });

  it("ending an assignment keeps it on record; finance sees every assignment with names, no phone numbers", async () => {
    const t = await teacher();
    const r = await rate(t, "Ending", 400);
    const c = await customer();
    const a = await assign(support1, { teacher_id: t, rate_id: r, enrollment_id: c.enrollment, started_on: "2026-10-20" });
    await expectError(as(support1, (q) => q("select public.end_teacher_assignment($1, '2026-10-01')", [a])), "CRM01", "before the start date");
    await as(support1, (q) => q("select public.end_teacher_assignment($1, '2026-10-30')", [a]));
    await expectError(as(support1, (q) => q("select public.end_teacher_assignment($1)", [a])), "CRM01", "already ended");
    const view = (await as(accountant, (q) => q<Record<string, unknown>>("select * from public.teacher_assignments_view()"))).find((x) => x.id === a)!;
    expect(view).toMatchObject({ teacher_id: t, enrollment_id: c.enrollment });
    expect(typeof view.customer_name).toBe("string");
    expect(Object.keys(view).some((k) => k.includes("phone"))).toBe(false);
    await expectError(as(support1, (q) => q("select * from public.teacher_assignments_view()")), "CRM03");
  });
});
