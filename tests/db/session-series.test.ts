/**
 * CRM changes, Part E (26 Oct 2026): weekly series of sessions are linked; moving or removing can
 * apply to this and the following sessions or the whole series, never to recorded ones. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createInquiry, createUser, expectError, type TestUser } from "./helpers";

let manager: TestUser, agent: TestUser, support1: TestUser, support2: TestUser;
let prog: string, course: string, teacher: string, rate: string;
const START = "2027-03-02T17:00:00+02:00"; // a Tuesday, 5 pm Cairo

async function customer(owner: TestUser = support1) {
  const inquiry = (await createInquiry(agent, { program_id: prog })).inquiry_id;
  const enrollment = await as(agent, async (q) => (await q<{ id: string }>("select public.save_enrollment($1) as id", [{ inquiry_id: inquiry, course_id: course, agreed_total: 8000 }]))[0].id);
  await admin("insert into public.onboardings (enrollment_id, support_owner_id, claimed_at, status) values ($1, $2, now(), 'onboarding')", [enrollment, owner.id]);
  const assignment = (await admin<{ id: string }>("insert into public.teacher_assignments (teacher_id, rate_id, enrollment_id, started_on) values ($1, $2, $3, '2027-01-01') returning id", [teacher, rate, enrollment]))[0].id;
  return { inquiry, assignment };
}
const schedule = (user: TestUser, assignment: string, extra: Record<string, unknown> = {}) =>
  as(user, (q) => q("select public.schedule_sessions($1)", [{ assignment_id: assignment, starts_at: START, planned_hours: 2, repeat_weeks: 5, ...extra }]));
const sessions = (assignment: string) =>
  admin<{ id: string; series_id: string | null; status: string; when: string; hours: string }>(
    "select id, series_id, status, to_char(starts_at at time zone 'Africa/Cairo', 'Dy DD Mon HH24:MI') as when, planned_hours::float8::text as hours from public.teacher_sessions where assignment_id = $1 order by starts_at", [assignment]);
const change = (user: TestUser, p: Record<string, unknown>) =>
  as(user, async (q) => (await q<{ r: { changed: number } }>("select public.change_session_series($1) as r", [p]))[0].r);
const info = (user: TestUser, id: string) =>
  as(user, async (q) => (await q<{ r: { seriesId: string | null; total: number; following: number; all: number; recorded: number } }>("select public.session_series_info($1) as r", [id]))[0].r);

beforeAll(async () => {
  manager = await createUser("manager", "Series Manager");
  agent = await createUser("sales", "Series Agent");
  support1 = await createUser("support", "Series Support One");
  support2 = await createUser("support", "Series Support Two");
  [{ id: prog }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('SERS', 'Series Program') returning id");
  const typeId = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course_type($1) as id", [{ name: "Series Private", color: "purple" }]))[0].id);
  course = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course($1) as id",
    [{ program_id: prog, course_type_id: typeId, name: "Series 12 x 2h", price: 8000, currency: "EGP", delivery: "online", sessions_count: 12, session_hours: 2 }]))[0].id);
  teacher = (await admin<{ id: string }>("insert into public.teachers (full_name) values ('Series Teacher') returning id"))[0].id;
  rate = (await admin<{ id: string }>("insert into public.teacher_rates (teacher_id, name) values ($1, 'Hour') returning id", [teacher]))[0].id;
  await admin("insert into public.teacher_rate_amounts (rate_id, amount, valid_from) values ($1, 400, '2020-01-01')", [rate]);
});
afterAll(async () => {
  await admin("update public.profiles set active = false where id = any($1)", [[agent.id, support1.id, support2.id]]);
  await admin("update public.profiles set active = false where id = $1", [manager.id]).catch(() => {});
  await closeDb();
});

describe("linked series", () => {
  it("a weekly series shares one series id; a single session has none", async () => {
    const c = await customer();
    await schedule(support1, c.assignment);
    await schedule(support1, c.assignment, { starts_at: "2027-02-20T10:00:00+02:00", repeat_weeks: 0 });
    const rows = await sessions(c.assignment);
    expect(rows[0].series_id).toBeNull(); // the single one, earliest
    expect(new Set(rows.slice(1).map((r) => r.series_id)).size).toBe(1);
    expect(rows.slice(1).every((r) => r.series_id)).toBe(true);
    const i = await info(support1, rows[3].id);
    expect([i.total, i.following, i.all, i.recorded]).toEqual([6, 4, 6, 0]);
    expect((await info(support1, rows[0].id)).seriesId).toBeNull();
  });
});

describe("moving", () => {
  it("this and the following sessions move by the same amount; earlier and recorded ones stay", async () => {
    const c = await customer();
    await schedule(support1, c.assignment);
    let rows = await sessions(c.assignment);
    // rows[3] is in the future, so it is marked recorded directly.
    await admin("update public.teacher_sessions set status = 'done', hours = 2, paid_hours = 2, student_hours = 2 where id = $1", [rows[3].id]);
    const r = await change(support1, { id: rows[2].id, scope: "following", action: "move", starts_at: "2027-03-17T18:00:00+02:00" }); // Tue 16th 5 pm → Wed 17th 6 pm
    expect(r.changed).toBe(3); // the 3rd, 5th and 6th; the recorded 4th stays
    rows = await sessions(c.assignment);
    expect(rows.map((x) => `${x.when} ${x.status}`)).toEqual([
      "Tue 02 Mar 17:00 scheduled", "Tue 09 Mar 17:00 scheduled", "Wed 17 Mar 18:00 scheduled", "Tue 23 Mar 17:00 done",
      "Wed 31 Mar 18:00 scheduled", "Wed 07 Apr 18:00 scheduled",
    ]);
    const [act] = await admin<{ body: string }>("select body from public.activities where inquiry_id = $1 and type = 'session' order by created_at desc limit 1", [c.inquiry]);
    expect(act.body).toBe("3 sessions with Series Teacher moved to Wednesdays, 6:00 PM");
  });

  it("all sessions can move, with a new length", async () => {
    const c = await customer();
    await schedule(support1, c.assignment);
    const rows = await sessions(c.assignment);
    await change(manager, { id: rows[4].id, scope: "all", action: "move", starts_at: "2027-03-30T16:00:00+02:00", planned_hours: 1.5 });
    const after = await sessions(c.assignment);
    expect(after.map((x) => x.when)).toEqual(["Tue 02 Mar 16:00", "Tue 09 Mar 16:00", "Tue 16 Mar 16:00", "Tue 23 Mar 16:00", "Tue 30 Mar 16:00", "Tue 06 Apr 16:00"]);
    expect(after.every((x) => x.hours === "1.5")).toBe(true);
  });

  it("refuses a move onto another session's time or outside the teacher's dates", async () => {
    const c = await customer();
    await schedule(support1, c.assignment);
    await schedule(support1, c.assignment, { starts_at: "2027-03-25T18:00:00+02:00", repeat_weeks: 0 });
    const rows = (await sessions(c.assignment)).filter((x) => x.series_id);
    await expectError(change(support1, { id: rows[3].id, scope: "following", action: "move", starts_at: "2027-03-25T18:00:00+02:00" }), "CRM01", "already a session");
    await admin("update public.teacher_assignments set ended_on = '2027-04-01' where id = $1", [c.assignment]);
    await expectError(change(support1, { id: rows[0].id, scope: "all", action: "move", starts_at: "2027-03-04T17:00:00+02:00" }), "CRM01", "outside the dates");
  });
});

describe("removing", () => {
  it("removes this and the following, or all of the series; recorded sessions stay", async () => {
    const c = await customer();
    await schedule(support1, c.assignment);
    let rows = await sessions(c.assignment);
    await admin("update public.teacher_sessions set status = 'done', hours = 2, paid_hours = 2, student_hours = 2 where id = $1", [rows[0].id]);
    expect((await change(support1, { id: rows[4].id, scope: "following", action: "remove" })).changed).toBe(2);
    rows = await sessions(c.assignment);
    expect(rows.length).toBe(4);
    expect((await change(support1, { id: rows[1].id, scope: "all", action: "remove" })).changed).toBe(3);
    rows = await sessions(c.assignment);
    expect(rows.map((x) => x.status)).toEqual(["done"]);
    await expectError(change(support1, { id: rows[0].id, scope: "all", action: "remove" }), "CRM01", "no sessions left to change");
  });
});

describe("who can change a series", () => {
  it("the customer's support owner and managers only", async () => {
    const c = await customer(support1);
    await schedule(support1, c.assignment);
    const [first] = await sessions(c.assignment);
    await expectError(change(support2, { id: first.id, scope: "all", action: "remove" }), "CRM04", "not assigned to you");
    await expectError(info(support2, first.id), "CRM04");
    await expectError(change(agent, { id: first.id, scope: "all", action: "remove" }), "CRM03");
    expect((await change(manager, { id: first.id, scope: "all", action: "remove" })).changed).toBe(6);
  });
});

describe("linking series made before Part E", () => {
  it("links sessions scheduled together (same moment, weekday, time, length); leaves singles alone", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../../supabase/migrations/20261101000001_session_series.sql", import.meta.url), "utf8");
    const backfill = sql.slice(sql.indexOf("with groups as ("), sql.indexOf("s.planned_hours = g.planned_hours;") + "s.planned_hours = g.planned_hours;".length);
    const c = await customer();
    await schedule(support1, c.assignment, { repeat_weeks: 3 });
    await schedule(support1, c.assignment, { starts_at: "2027-02-20T10:00:00+02:00", repeat_weeks: 0 });
    // A separate pair scheduled at the same moment but at different times: not a weekly series.
    await admin(`insert into public.teacher_sessions (assignment_id, teacher_id, rate_id, enrollment_id, starts_at, planned_hours, created_at)
                 select id, teacher_id, rate_id, enrollment_id, t, 2, '2027-01-05 09:00+02' from public.teacher_assignments, unnest(array['2027-05-04 17:00+03', '2027-05-06 12:00+03']::timestamptz[]) t where id = $1`, [c.assignment]);
    await admin("update public.teacher_sessions set series_id = null where assignment_id = $1", [c.assignment]); // as before Part E
    await admin(backfill);
    const rows = await sessions(c.assignment);
    const weekly = rows.filter((x) => x.when.startsWith("Tue") && x.when.includes("17:00") && x.when.includes("Mar"));
    expect(weekly.length).toBe(4);
    expect(new Set(weekly.map((x) => x.series_id)).size).toBe(1);
    expect(weekly[0].series_id).not.toBeNull();
    expect(rows.filter((x) => !weekly.includes(x)).every((x) => x.series_id === null)).toBe(true);
  });
});
