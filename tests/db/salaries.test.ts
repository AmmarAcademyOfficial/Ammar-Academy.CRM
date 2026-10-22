/**
 * Accounting plan, phase 5 (22 Oct 2026): teacher salaries per Academy month (26th–25th), manual
 * bonus/deduction lines, closing and reopening a month, and who may do what. Synthetic data only.
 * Months used here are far in the past or future so no other test file touches them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createInquiry, createUser, expectError, type TestUser } from "./helpers";

let manager: TestUser, accountant: TestUser, agent: TestUser, support: TestUser;
let prog: string, course: string, enrollment: string;

interface Line { rateName: string; currency: string; perHour: number; hours: number; sessions: number; amount: number }
interface Adjustment { id: string; kind: string; amount: number; currency: string; note: string }
interface TeacherRow { teacherId: string; name: string; lines: Line[]; adjustments: Adjustment[]; totals: Record<string, number> }
interface Report { month: string; from: string; to: string; status: string; teachers: TeacherRow[]; totals: Record<string, number>; unrecorded: number; ended: boolean; reopenReason: string | null }

const report = (user: TestUser, month: string) =>
  as(user, async (q) => (await q<{ r: Report }>("select public.salary_report($1) as r", [month]))[0].r);
const rowFor = (r: Report, teacher: string) => r.teachers.find((t) => t.teacherId === teacher);

async function makeTeacher(name: string, rates: { name: string; currency?: string; amounts: [number, string][] }[]) {
  const id = (await admin<{ id: string }>("insert into public.teachers (full_name) values ($1) returning id", [name]))[0].id;
  const rateIds: string[] = [];
  for (const r of rates) {
    const rid = (await admin<{ id: string }>("insert into public.teacher_rates (teacher_id, name, currency) values ($1, $2, $3) returning id", [id, r.name, r.currency ?? "EGP"]))[0].id;
    for (const [amount, from] of r.amounts) await admin("insert into public.teacher_rate_amounts (rate_id, amount, valid_from) values ($1, $2, $3)", [rid, amount, from]);
    rateIds.push(rid);
  }
  return { id, rateIds };
}
async function assignment(teacher: string, rate: string, group = false) {
  return (await admin<{ id: string }>(
    `insert into public.teacher_assignments (teacher_id, rate_id, ${group ? "course_id" : "enrollment_id"}, started_on) values ($1, $2, $3, '2020-01-01') returning id`,
    [teacher, rate, group ? course : enrollment]))[0].id;
}
async function session(a: string, startsAt: string, status: string, paid: number, group = false) {
  const [as_] = await admin<{ teacher_id: string; rate_id: string }>("select teacher_id, rate_id from public.teacher_assignments where id = $1", [a]);
  return (await admin<{ id: string }>(
    `insert into public.teacher_sessions (assignment_id, teacher_id, rate_id, ${group ? "course_id" : "enrollment_id"}, starts_at, planned_hours, status, hours, paid_hours, student_hours)
     values ($1, $2, $3, $4, $5, 2, $6, $7, $8, $8) returning id`,
    [a, as_.teacher_id, as_.rate_id, group ? course : enrollment, startsAt, status, status === "done" ? paid : null, paid]))[0].id;
}

beforeAll(async () => {
  manager = await createUser("manager", "Sal Manager");
  accountant = await createUser("accountant", "Sal Accountant");
  agent = await createUser("sales", "Sal Agent");
  support = await createUser("support", "Sal Support");
  [{ id: prog }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('SALX', 'Salary Program') returning id");
  const typeId = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course_type($1) as id", [{ name: "Sal Type", color: "blue" }]))[0].id);
  course = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course($1) as id",
    [{ program_id: prog, course_type_id: typeId, name: "Sal Group", price: 5000, currency: "EGP", delivery: "online" }]))[0].id);
  const inquiry = (await createInquiry(agent, { program_id: prog })).inquiry_id;
  enrollment = await as(agent, async (q) => (await q<{ id: string }>("select public.save_enrollment($1) as id", [{ inquiry_id: inquiry, course_id: course, agreed_total: 5000 }]))[0].id);
});
afterAll(async () => {
  await admin("update public.profiles set active = false where id = any($1)", [[accountant.id, agent.id, support.id]]);
  await admin("update public.profiles set active = false where id = $1", [manager.id]).catch(() => {});
  await closeDb();
});

describe("the month and the pay", () => {
  it("runs from the 26th to the 25th and is named after the month it ends in", async () => {
    const r = await report(accountant, "2025-03");
    expect([r.from, r.to]).toEqual(["2025-02-26", "2025-03-25"]);
    expect(r.status).toBe("open");
    expect(r.ended).toBe(true);
    expect((await report(manager, "2030-01")).ended).toBe(false);
  });

  it("counts paid hours × the amount on each session's day, in that rate's currency", async () => {
    const t = await makeTeacher("Sal Teacher Pay", [
      { name: "Private", amounts: [[400, "2020-01-01"], [500, "2025-03-10"]] },
      { name: "Group", amounts: [[600, "2020-01-01"]] },
      { name: "USD private", currency: "USD", amounts: [[20, "2020-01-01"]] },
    ]);
    const priv = await assignment(t.id, t.rateIds[0]);
    const grp = await assignment(t.id, t.rateIds[1], true);
    const usd = await assignment(t.id, t.rateIds[2]);
    await session(priv, "2025-02-25T18:00:00+02:00", "done", 2);          // 25 Feb: previous month
    await session(priv, "2025-02-26T18:00:00+02:00", "done", 1.5);        // 26 Feb: first day, 400
    await session(priv, "2025-03-05T18:00:00+02:00", "no_show", 2);       // paid by the rules, 400
    await session(priv, "2025-03-12T18:00:00+02:00", "done", 2);          // after the raise, 500
    await session(priv, "2025-03-13T18:00:00+02:00", "cancelled_student", 0); // cancelled in time: not paid
    await session(grp, "2025-03-14T18:00:00+02:00", "done", 2, true);     // a group class is paid once
    await session(usd, "2025-03-20T18:00:00+02:00", "done", 1);
    await session(priv, "2025-03-25T23:30:00+02:00", "done", 1);          // 25 Mar late evening Cairo: still this month, 500

    const row = rowFor(await report(accountant, "2025-03"), t.id)!;
    expect(row.lines.map((l) => [l.rateName, l.perHour, l.hours, l.sessions, l.amount, l.currency])).toEqual([
      ["Group", 600, 2, 1, 1200, "EGP"],
      ["Private", 400, 3.5, 2, 1400, "EGP"],
      ["Private", 500, 3, 2, 1500, "EGP"],
      ["USD private", 20, 1, 1, 20, "USD"],
    ]);
    expect(row.totals).toEqual({ EGP: 4100, USD: 20 });
  });

  it("adds bonus and deduction lines; EGP and USD are never summed together", async () => {
    const t = await makeTeacher("Sal Teacher Adjust", [{ name: "Hour", amounts: [[300, "2020-01-01"]] }]);
    await session(await assignment(t.id, t.rateIds[0]), "2025-04-01T18:00:00+02:00", "done", 2);
    const save = (user: TestUser, p: Record<string, unknown>) =>
      as(user, async (q) => (await q<{ id: string }>("select public.save_salary_adjustment($1) as id", [{ month: "2025-04", teacher_id: t.id, ...p }]))[0].id);
    const bonus = await save(accountant, { kind: "bonus", amount: 250, currency: "EGP", note: "Extra mock exam" });
    await save(manager, { kind: "deduction", amount: 100, currency: "EGP", note: "Late to two classes" });
    await save(manager, { kind: "bonus", amount: 15, currency: "USD", note: "Weekend session" });
    let row = rowFor(await report(accountant, "2025-04"), t.id)!;
    expect(row.adjustments.map((a) => [a.kind, a.amount, a.currency])).toEqual([["bonus", 250, "EGP"], ["deduction", 100, "EGP"], ["bonus", 15, "USD"]]);
    expect(row.totals).toEqual({ EGP: 750, USD: 15 });

    await save(accountant, { id: bonus, kind: "bonus", amount: 300, currency: "EGP", note: "Extra mock exam (2 hours)" });
    await as(accountant, (q) => q("select public.delete_salary_adjustment($1)", [row.adjustments[1].id]));
    row = rowFor(await report(accountant, "2025-04"), t.id)!;
    expect(row.totals).toEqual({ EGP: 900, USD: 15 });

    await expectError(save(accountant, { kind: "bonus", amount: 50, currency: "EGP", note: " " }), "CRM01", "short reason");
    await expectError(save(accountant, { kind: "gift", amount: 50, note: "x" }), "CRM01", "bonus or deduction");
    await expectError(save(accountant, { kind: "bonus", amount: 0, note: "x" }), "CRM01", "amount");
    await expectError(save(support, { kind: "bonus", amount: 50, note: "x" }), "CRM03");
    await expectError(save(agent, { kind: "bonus", amount: 50, note: "x" }), "CRM03");
  });
});

describe("closing and reopening a month", () => {
  it("only managers close, only after the month ends, and only when every session is recorded", async () => {
    const t = await makeTeacher("Sal Teacher Close", [{ name: "Hour", amounts: [[400, "2020-01-01"]] }]);
    const a = await assignment(t.id, t.rateIds[0]);
    await session(a, "2025-05-02T18:00:00+03:00", "done", 2);
    const pending = await session(a, "2025-05-09T18:00:00+03:00", "scheduled", 0);
    const close = (user: TestUser, m = "2025-05") => as(user, (q) => q("select public.close_salary_month($1)", [m]));

    await expectError(close(accountant), "CRM03");
    await expectError(close(support), "CRM03");
    await expectError(close(manager, "2030-01"), "CRM01", "Close it after that day");
    expect((await report(manager, "2025-05")).unrecorded).toBe(1);
    await expectError(close(manager), "CRM01", "1 session in this month is not recorded yet");

    await admin("update public.teacher_sessions set status = 'done', hours = 1, paid_hours = 1, student_hours = 1 where id = $1", [pending]);
    await close(manager);
    const r = await report(accountant, "2025-05");
    expect(r.status).toBe("closed");
    expect(rowFor(r, t.id)!.totals).toEqual({ EGP: 1200 });
  });

  it("a closed month is frozen: rates, sessions and adjustments no longer change it", async () => {
    const t = await makeTeacher("Sal Teacher Frozen", [{ name: "Hour", amounts: [[400, "2020-01-01"]] }]);
    const a = await assignment(t.id, t.rateIds[0]);
    const s = await session(a, "2025-06-03T18:00:00+03:00", "done", 2);
    await as(manager, (q) => q("select public.close_salary_month('2025-06')"));

    // A later rate change back-dated into the month does not alter the closed figures.
    await as(manager, (q) => q("select public.set_teacher_rate_amount($1, 900, '2025-06-01')", [t.rateIds[0]]));
    expect(rowFor(await report(manager, "2025-06"), t.id)!.totals).toEqual({ EGP: 800 });

    await expectError(as(manager, (q) => q("select public.record_session($1)", [{ id: s, status: "done", hours: 3 }])), "CRM01", /Salaries for June 2025 are closed/);
    await expectError(admin("delete from public.teacher_sessions where id = $1", [s]), "CRM01", "closed");
    await expectError(session(a, "2025-06-10T18:00:00+03:00", "done", 1), "CRM01", "closed");
    await expectError(as(accountant, (q) => q("select public.save_salary_adjustment($1)",
      [{ month: "2025-06", teacher_id: t.id, kind: "bonus", amount: 10, currency: "EGP", note: "Late bonus" }])), "CRM01", "closed");
    // The next month is unaffected (26 Jun counts towards July).
    await session(a, "2025-06-26T18:00:00+03:00", "done", 1);
  });

  it("managers reopen with a reason; the month is worked out live again", async () => {
    const t = await makeTeacher("Sal Teacher Reopen", [{ name: "Hour", amounts: [[400, "2020-01-01"]] }]);
    await session(await assignment(t.id, t.rateIds[0]), "2025-07-03T18:00:00+03:00", "done", 2);
    await as(manager, (q) => q("select public.close_salary_month('2025-07')"));
    await as(manager, (q) => q("select public.set_teacher_rate_amount($1, 450, '2025-07-01')", [t.rateIds[0]]));
    await expectError(as(accountant, (q) => q("select public.reopen_salary_month('2025-07', 'Fix')")), "CRM03");
    await expectError(as(manager, (q) => q("select public.reopen_salary_month('2025-07', '  ')")), "CRM01", "reason");
    await as(manager, (q) => q("select public.reopen_salary_month('2025-07', 'Rate was raised in July')"));
    const r = await report(manager, "2025-07");
    expect(r.status).toBe("open");
    expect(r.reopenReason).toBe("Rate was raised in July");
    expect(rowFor(r, t.id)!.totals).toEqual({ EGP: 900 });
    const [log] = await admin<{ n: number }>("select count(*)::int as n from public.audit_log where action like 'Reopened salaries for July 2025%'");
    expect(log.n).toBe(1);
  });
});

describe("who sees salaries", () => {
  it("sales and support cannot open the report or read the salary tables", async () => {
    await expectError(report(support, "2025-03"), "CRM03");
    await expectError(report(agent, "2025-03"), "CRM03");
    for (const user of [support, agent]) {
      const counts = await as(user, (q) => q<{ a: number; l: number; m: number }>(
        "select (select count(*) from public.salary_adjustments)::int as a, (select count(*) from public.salary_lines)::int as l, (select count(*) from public.salary_months)::int as m"));
      expect(counts[0]).toEqual({ a: 0, l: 0, m: 0 });
    }
    const fin = await as(accountant, (q) => q<{ l: number }>("select count(*)::int as l from public.salary_lines"));
    expect(fin[0].l).toBeGreaterThan(0);
  });

  it("rejects a malformed month", async () => {
    await expectError(report(manager, "2025-13"), "CRM01", "Choose a month");
  });
});
