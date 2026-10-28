/** Phase 5: report figures and working-hours time to first contact. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createInquiry, createUser, expectError, outcomeId, type TestUser, cairoDate } from "./helpers";

let manager: TestUser, agentA: TestUser, agentB: TestUser, support: TestUser, nightAgent: TestUser;
let prog: string, groupType: string, privateType: string, groupCourse: string, privateCourse: string;
const RECEIPT = { path: "receipts/11111111-2222-4333-8444-666666666666.pdf", name: "r.pdf", mime: "application/pdf", size: 900 };
const cairo = (local: string) => `('${local}'::timestamp at time zone 'Africa/Cairo')`;
const cairoToday = () => cairoDate();
const shift = (u: TestUser, weekday: number, start: string, end: string) => {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  return admin("insert into public.shifts (user_id, weekday, start_minute, end_minute, program_ids) values ($1, $2, $3, $4, array[$5]::uuid[])", [u.id, weekday, m(start), m(end), prog]);
};
const workMin = async (u: TestUser, from: string, to: string) =>
  Number((await admin<{ m: string }>(`select private.working_minutes($1, ${cairo(from)}, ${cairo(to)}) as m`, [u.id]))[0].m);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const report = async (p: Record<string, unknown>, user = manager): Promise<any> =>
  as(user, async (q) => (await q<{ r: unknown }>("select public.report($1) as r", [{ from: cairoToday(), to: cairoToday(), program_id: prog, ...p }]))[0].r);

beforeAll(async () => {
  manager = await createUser("manager", "Report Manager");
  agentA = await createUser("sales", "Report Agent A");
  agentB = await createUser("sales", "Report Agent B");
  nightAgent = await createUser("sales", "Report Night Agent");
  support = await createUser("support", "Report Support");
  [{ id: prog }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('REPA', 'Report Program') returning id");
  const mkType = (name: string) => as(manager, async (q) => (await q<{ id: string }>("select public.save_course_type($1) as id", [{ name }]))[0].id);
  groupType = await mkType("Report Group");
  privateType = await mkType("Report Private");
  const mk = (p: Record<string, unknown>) => as(manager, async (q) => (await q<{ id: string }>("select public.save_course($1) as id", [{ program_id: prog, currency: "EGP", ...p }]))[0].id);
  groupCourse = await mk({ name: "Report Group Course", course_type_id: groupType, price: 10000 });
  privateCourse = await mk({ name: "Report Private Course", course_type_id: privateType, price: 6000 });
  // Agent A: Sun–Thu 09:00–17:00. Night agent: Thu 22:00–02:00 (overnight). Agent B: no shifts.
  for (const d of [0, 1, 2, 3, 4]) await shift(agentA, d, "09:00", "17:00");
  await shift(nightAgent, 4, "22:00", "02:00");
});
afterAll(closeDb);

describe("working-hours time to first contact", () => {
  it("counts only scheduled shift minutes, across the weekend", async () => {
    // Thursday 8 Oct 16:50 → Sunday 11 Oct 09:10 = 10 min Thursday + 10 min Sunday.
    expect(await workMin(agentA, "2026-10-08 16:50", "2026-10-11 09:10")).toBe(20);
    // Entirely outside the shift.
    expect(await workMin(agentA, "2026-10-08 18:00", "2026-10-08 23:00")).toBe(0);
    // Within one shift.
    expect(await workMin(agentA, "2026-10-12 10:00", "2026-10-12 10:45")).toBe(45);
  });

  it("handles overnight shifts and skips leave days", async () => {
    // Thu 22:00 → Fri 02:00 shift; lead at Thu 23:30, contacted Fri 01:15 = 105 min.
    expect(await workMin(nightAgent, "2026-10-08 23:30", "2026-10-09 01:15")).toBe(105);
    await admin("insert into public.time_off (user_id, starts_on, ends_on) values ($1, '2026-10-12', '2026-10-12')", [agentA.id]);
    // Monday 12 Oct is leave: Sunday 16:00 → Tuesday 09:30 = 60 + 30.
    expect(await workMin(agentA, "2026-10-11 16:00", "2026-10-13 09:30")).toBe(90);
  });

  it("an agent with no shifts is measured in clock time", async () => {
    expect(await workMin(agentB, "2026-10-08 23:00", "2026-10-09 01:30")).toBe(150);
  });
});

describe("report figures", () => {
  let enrolledLead: string;

  beforeAll(async () => {
    // Five inquiries today: A gets 3 (two on the group course), B gets 2 (one private course, one lost).
    const make = async (u: TestUser, course: string | null) => {
      const id = (await createInquiry(u, { program_id: prog })).inquiry_id;
      if (course) await as(u, (q) => q("select public.set_inquiry_course($1, $2)", [id, course]));
      return id;
    };
    enrolledLead = await make(agentA, groupCourse);
    const a2 = await make(agentA, groupCourse);
    await make(agentA, null);
    const b1 = await make(agentB, privateCourse);
    const b2 = await make(agentB, null);
    // First contact: a2 contacted 30 minutes after assignment (assignment moved back so the time is known).
    // (Never before today's Cairo midnight, so the test works at any time of day.)
    await admin(`update public.inquiries set assigned_at = greatest(now() - interval '30 minutes', date_trunc('day', now() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo') where id = $1`, [a2]);
    await as(agentA, async (q) => q("select public.record_contact_attempt($1, $2)", [a2, await outcomeId("reached")]));
    await as(agentB, async (q) => q("select public.record_contact_attempt($1, $2)", [b1, await outcomeId("reached")]));
    await as(agentA, async (q) => q("select public.record_contact_attempt($1, $2)", [enrolledLead, await outcomeId("reached")]));
    // b2 lost with a reason.
    const v = (await admin<{ version: number }>("select version from public.inquiries where id = $1", [b2]))[0].version;
    await as(agentB, (q) => q("select public.change_stage($1, 'lost', $2, $3)", [b2, v, "Chose another academy"]));
    // enrolledLead: full payment confirmed → Enrolled and handed over.
    const e = await as(agentA, async (q) => (await q<{ id: string }>("select public.save_enrollment($1) as id", [{ inquiry_id: enrolledLead, course_id: groupCourse, agreed_total: 10000 }]))[0].id);
    const p = await as(agentA, async (q) => (await q<{ id: string }>("select public.submit_payment($1) as id", [{
      enrollment_id: e, amount: 10000, paid_on: cairoToday(), method: "bank_transfer", reference: "REP-1", receipt: RECEIPT }]))[0].id);
    await as(manager, (q) => q("select public.decide_payment($1, 'confirmed', null)", [p]));
    // A rejected payment never counts.
    const e2 = await as(agentB, async (q) => (await q<{ id: string }>("select public.save_enrollment($1) as id", [{ inquiry_id: b1, course_id: privateCourse, agreed_total: 6000 }]))[0].id);
    const p2 = await as(agentB, async (q) => (await q<{ id: string }>("select public.submit_payment($1) as id", [{
      enrollment_id: e2, amount: 2000, paid_on: cairoToday(), method: "cash", reference: "" }]))[0].id);
    await as(manager, (q) => q("select public.decide_payment($1, 'rejected', 'Wrong amount')", [p2]));
  });

  it("is manager-only and checks the range", async () => {
    await expectError(report({}, agentA), "CRM03");
    await expectError(report({}, support), "CRM03");
    await expectError(report({ from: "2026-10-10", to: "2026-10-01" }), "CRM01", "before the start");
    await expectError(report({ from: "2020-01-01", to: "2026-10-01" }), "CRM01", "two years");
  });

  it("counts inquiries, stages, sources, assignments and lost reasons", async () => {
    const r = await report({});
    expect(r.newInquiries).toBe(5);
    expect(r.distinctContacts).toBe(5);
    expect(r.assignedTotal).toBe(5);
    expect(r.inquiriesWithoutCourse).toBe(2);
    expect(r.bySource).toEqual([{ label: "Manual entry", count: 5 }]);
    const stages = Object.fromEntries(r.byStage.map((s: { key: string; count: number }) => [s.key, s.count]));
    expect(stages.enrolled).toBe(1);
    expect(stages.lost).toBe(1);
    expect(r.lostTotal).toBe(1);
    expect(r.lostReasons).toEqual([{ label: "Chose another academy", count: 1 }]);
    expect(r.daily).toHaveLength(1);
    expect(r.daily[0]).toMatchObject({ inquiries: 5, enrollments: 1 });
  });

  it("only confirmed payments count, and enrollments are counted once at handover", async () => {
    const r = await report({});
    expect(r.enrollments).toBe(1);
    expect(r.confirmed).toEqual([{ currency: "EGP", amount: 10000, count: 1 }]);
    expect(r.support).toMatchObject({ handedOver: 1, claimed: 0, activated: 0 });
    expect(r.awaitingOnboarding).toBe(1);
  });

  it("per-agent figures credit the agent who made the sale", async () => {
    const r = await report({});
    const a = r.agents.find((x: { userId: string }) => x.userId === agentA.id);
    const b = r.agents.find((x: { userId: string }) => x.userId === agentB.id);
    expect(a).toMatchObject({ assigned: 3, contacted: 2, enrollments: 1, assignedNowEnrolled: 1, confirmed: [{ currency: "EGP", amount: 10000 }] });
    expect(b).toMatchObject({ assigned: 2, contacted: 1, enrollments: 0, confirmed: [] });
    // a2 was contacted 30 minutes after assignment; agent A has no shift at most test times, so only check it is measured.
    expect(r.firstContact.measured).toBeGreaterThanOrEqual(2);
    expect(r.firstContact.notYet).toBe(2); // the lead with no course, and the lost lead
  });

  it("filters by course type and breaks figures down by course", async () => {
    const r = await report({});
    const g = r.courses.find((c: { courseId: string }) => c.courseId === groupCourse);
    expect(g).toMatchObject({ inquiries: 2, enrollments: 1, confirmed: [{ currency: "EGP", amount: 10000 }] });
    const pv = r.courses.find((c: { courseId: string }) => c.courseId === privateCourse);
    expect(pv).toMatchObject({ inquiries: 1, enrollments: 0, confirmed: [] });

    const onlyPrivate = await report({ course_type_id: privateType });
    expect(onlyPrivate.newInquiries).toBe(1);
    expect(onlyPrivate.enrollments).toBe(0);
    expect(onlyPrivate.confirmed).toEqual([]);
    expect(onlyPrivate.courses.map((c: { courseId: string }) => c.courseId)).toEqual([privateCourse]);
  });

  it("an earlier range sees none of today's activity", async () => {
    const r = await report({ from: "2026-01-01", to: "2026-01-31" });
    expect(r.newInquiries).toBe(0);
    expect(r.enrollments).toBe(0);
    expect(r.daily).toHaveLength(31);
  });
});
