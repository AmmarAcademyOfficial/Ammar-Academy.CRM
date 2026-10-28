/**
 * CRM changes plan 3, release 3 (28 Oct 2026): delete teachers and rates. Never used: deleted at
 * once and restorable for 30 days. Already used: refused, with what links it, so Not active or
 * Archive keep the history. Managers only. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createInquiry, createUser, expectError, type TestUser } from "./helpers";

let manager: TestUser, accountant: TestUser, support: TestUser, agent: TestUser;
let prog: string, course: string;

const one = async <T,>(user: TestUser, sql: string, params: unknown[]) => as(user, async (q) => (await q<{ r: T }>(sql, params))[0].r);
const preview = (user: TestUser, kind: string, id: string) =>
  one<{ label: string; summary: string; used: boolean; linked: string | null; needsTyped: boolean }>(user, "select public.delete_preview($1, $2) as r", [kind, id]);
const del = (user: TestUser, p: Record<string, unknown>) => one<{ id: string; summary: string }>(user, "select public.delete_record($1) as r", [p]);
const restore = (user: TestUser, id: string) => one<{ kind: string }>(user, "select public.restore_deleted($1) as r", [id]);
const exists = async (table: string, id: string) => (await admin<{ n: number }>(`select count(*)::int as n from public.${table} where id = $1`, [id]))[0].n === 1;

async function teacher(name: string, rates = ["Hour"]) {
  const id = (await admin<{ id: string }>("insert into public.teachers (full_name) values ($1) returning id", [name]))[0].id;
  const rateIds: string[] = [];
  for (const r of rates) {
    const rid = (await admin<{ id: string }>("insert into public.teacher_rates (teacher_id, name) values ($1, $2) returning id", [id, r]))[0].id;
    await admin("insert into public.teacher_rate_amounts (rate_id, amount, valid_from) values ($1, 250, '2026-01-01'), ($1, 300, '2026-06-01')", [rid]);
    rateIds.push(rid);
  }
  return { id, rateIds };
}
async function enrollment() {
  const inquiry = (await createInquiry(agent, { program_id: prog })).inquiry_id;
  return one<string>(agent, "select public.save_enrollment($1) as r", [{ inquiry_id: inquiry, course_id: course, agreed_total: 5000 }]);
}

beforeAll(async () => {
  manager = await createUser("manager", "TDel Manager");
  accountant = await createUser("accountant", "TDel Accountant");
  support = await createUser("support", "TDel Support");
  agent = await createUser("sales", "TDel Agent");
  [{ id: prog }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('TDEL', 'Teacher Delete Program') returning id");
  const typeId = await one<string>(manager, "select public.save_course_type($1) as r", [{ name: "TDel Type", color: "blue" }]);
  course = await one<string>(manager, "select public.save_course($1) as r", [{ program_id: prog, course_type_id: typeId, name: "TDel Course", price: 5000, currency: "EGP", delivery: "online" }]);
});
afterAll(async () => {
  await admin("update public.profiles set active = false where id = any($1)", [[accountant.id, support.id, agent.id]]);
  await admin("update public.profiles set active = false where id = $1", [manager.id]).catch(() => {});
  await closeDb();
});

describe("teachers and rates never used", () => {
  it("only managers may delete them", async () => {
    const t = await teacher("TDel Unused One");
    for (const u of [accountant, support, agent]) {
      await expectError(preview(u, "teacher", t.id), "CRM03");
      await expectError(del(u, { kind: "rate", id: t.rateIds[0], reason: "x" }), "CRM03");
    }
  });

  it("a teacher goes at once with their rates and amounts, and comes back exactly as it was", async () => {
    const t = await teacher("TDel Unused Two", ["Private", "Group"]);
    const before = await admin("select to_jsonb(x) as j from public.teachers x where id = $1", [t.id]);
    const p = await preview(manager, "teacher", t.id);
    expect(p).toMatchObject({ label: "TDel Unused Two", summary: "1 teacher, 2 rates", used: false, linked: null, needsTyped: false });
    await expectError(del(manager, { kind: "teacher", id: t.id, reason: "" }), "CRM01", "reason");
    const r = await del(manager, { kind: "teacher", id: t.id, reason: "Added by mistake" });
    expect(await exists("teachers", t.id)).toBe(false);
    expect(await exists("teacher_rates", t.rateIds[0])).toBe(false);
    const audit = await admin<{ action: string }>("select action from public.audit_log where details ->> 'record_id' = $1", [t.id]);
    expect(audit.map((a) => a.action)).toEqual(["Deleted teacher (Added by mistake)"]);
    expect(await restore(manager, r.id)).toMatchObject({ kind: "teacher" });
    expect(await admin("select to_jsonb(x) as j from public.teachers x where id = $1", [t.id])).toEqual(before);
    expect((await admin<{ n: number }>("select count(*)::int as n from public.teacher_rate_amounts a join public.teacher_rates r on r.id = a.rate_id where r.teacher_id = $1", [t.id]))[0].n).toBe(4);
  });

  it("a rate goes alone; it comes back only while its teacher is there", async () => {
    const t = await teacher("TDel Unused Three", ["Private", "Group"]);
    const r = await del(manager, { kind: "rate", id: t.rateIds[1], reason: "Duplicate rate" });
    expect(await exists("teacher_rates", t.rateIds[1])).toBe(false);
    expect(await exists("teacher_rates", t.rateIds[0])).toBe(true);
    const rt = await del(manager, { kind: "teacher", id: t.id, reason: "Left" });
    await expectError(restore(manager, r.id), "CRM01", "Restore the teacher first");
    await restore(manager, rt.id);
    await restore(manager, r.id);
    expect(await exists("teacher_rates", t.rateIds[1])).toBe(true);
  });
});

describe("teachers and rates already used", () => {
  it("are refused, saying what links them, so Not active or Archive keep the history", async () => {
    const t = await teacher("TDel Used", ["Private", "Spare"]);
    const e = await enrollment();
    const [{ id: a }] = await admin<{ id: string }>("insert into public.teacher_assignments (teacher_id, rate_id, enrollment_id, started_on) values ($1, $2, $3, '2026-09-01') returning id", [t.id, t.rateIds[0], e]);
    await admin(`insert into public.teacher_sessions (assignment_id, teacher_id, rate_id, enrollment_id, starts_at, planned_hours, status, hours, paid_hours, student_hours)
                 values ($1, $2, $3, $4, '2026-09-10T10:00:00Z', 1, 'done', 1, 1, 1), ($1, $2, $3, $4, '2026-12-10T10:00:00Z', 1, 'scheduled', null, 0, 0)`, [a, t.id, t.rateIds[0], e]);
    const p = await preview(manager, "teacher", t.id);
    expect(p).toMatchObject({ used: true, linked: "1 customer, 1 recorded session, 1 scheduled session" });
    await expectError(del(manager, { kind: "teacher", id: t.id, reason: "Cleanup" }), "CRM01", "Set the teacher to Not active instead");
    expect((await preview(manager, "rate", t.rateIds[0])).used).toBe(true);
    await expectError(del(manager, { kind: "rate", id: t.rateIds[0], reason: "Cleanup" }), "CRM01", "Archive the rate instead");
    // The rate nobody used can still go.
    expect((await preview(manager, "rate", t.rateIds[1])).used).toBe(false);
    await del(manager, { kind: "rate", id: t.rateIds[1], reason: "Never used" });
    expect(await exists("teachers", t.id)).toBe(true);
  });

  it("group courses and closed salary months count as use", async () => {
    const t = await teacher("TDel Group");
    await admin("insert into public.teacher_assignments (teacher_id, rate_id, course_id, started_on) values ($1, $2, $3, '2026-09-01')", [t.id, t.rateIds[0], course]);
    await admin("insert into public.salary_months (month, status) values ('2026-08-01', 'closed') on conflict (month) do update set status = 'closed'");
    await admin("insert into public.salary_lines (month, teacher_id, rate_id, rate_name, currency, per_hour, hours, sessions, amount) values ('2026-08-01', $1, $2, 'Hour', 'EGP', 250, 2, 1, 500)", [t.id, t.rateIds[0]]);
    const p = await preview(manager, "teacher", t.id);
    expect(p).toMatchObject({ used: true, linked: "1 group course, 1 closed salary month" });
  });

  it("a teacher whose sessions are in a deleted enrollment that can still be restored counts as used", async () => {
    const t = await teacher("TDel Snapshot");
    const e = await enrollment();
    await admin("insert into public.teacher_assignments (teacher_id, rate_id, enrollment_id, started_on) values ($1, $2, $3, '2026-09-01')", [t.id, t.rateIds[0], e]);
    await del(manager, { kind: "enrollment", id: e, reason: "Wrong course" });
    const p = await preview(manager, "teacher", t.id);
    expect(p).toMatchObject({ used: true, linked: "1 deleted item that can still be restored" });
  });
});
