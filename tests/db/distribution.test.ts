/**
 * Shifts, eligibility and round-robin distribution (Phase 3).
 * Uses its own programs so agents and queues here never touch other test files.
 * Times are fixed instants; Cairo is UTC+2 in January.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createUser, expectError, newPhone, type TestUser } from "./helpers";

const MON_10 = "2026-01-12 10:00+02"; // Monday 10:00 Cairo

let manager: TestUser;
let progA: string; // "DISTA"
let progB: string; // "DISTB"
let n = 0;

async function newProgram(code: string): Promise<string> {
  const [p] = await admin<{ id: string }>("insert into public.programs (code, name) values ($1, $1) returning id", [code]);
  await admin("insert into public.rotation_state (program_id) values ($1) on conflict do nothing", [p.id]);
  return p.id;
}

async function agent(name: string, order: number): Promise<TestUser> {
  const u = await createUser("sales", name);
  await admin("update public.profiles set rotation_order = $2 where id = $1", [u.id, order]);
  return u;
}

async function shift(user: TestUser, weekday: number, start: string, end: string, programs: string[]) {
  return as(manager, async (q) => (await q<{ id: string }>("select public.save_shift($1) as id", [{ user_id: user.id, weekday, start, end, program_ids: programs }]))[0].id);
}

/** Every day, all day, for these programs. */
async function alwaysOn(user: TestUser, programs: string[]) {
  for (let d = 0; d < 7; d++) await shift(user, d, "00:00", "00:00", programs);
}

/** A waiting inquiry in a program, created directly (no auto-assignment), oldest first by `minutesAgo`. */
async function waiting(program: string, minutesAgo = 0): Promise<string> {
  const phone = newPhone();
  const [c] = await admin<{ id: string }>("insert into public.contacts (name, phone, phone_normalized) values ($1, $2, $2) returning id", [`Waiting ${++n}`, phone]);
  const [i] = await admin<{ id: string }>(
    `insert into public.inquiries (contact_id, program_id, stage_id, source, created_at)
     values ($1, $2, (select id from public.stages where system_key = 'new'), 'manual', now() - make_interval(mins => $3)) returning id`,
    [c.id, program, minutesAgo]);
  return i.id;
}

const reason = async (u: TestUser, program: string, when: string) =>
  (await admin<{ r: string | null }>("select private.ineligible_reason($1, $2, $3) as r", [u.id, program, when]))[0].r;
const assign = async (inquiry: string, when: string) =>
  (await admin<{ a: string | null }>("select private.assign_next($1, $2) as a", [inquiry, when]))[0].a;
const owner = async (inquiry: string) =>
  (await admin<{ o: string | null }>("select sales_owner_id as o from public.inquiries where id = $1", [inquiry]))[0].o;

beforeAll(async () => {
  manager = await createUser("manager", "Dist Manager");
  progA = await newProgram("DISTA");
  progB = await newProgram("DISTB");
});
afterAll(closeDb);

describe("shift coverage in Cairo time", () => {
  it("day shift covers its hours only, end excluded", async () => {
    const a = await agent("Day Agent", 900);
    await shift(a, 1, "09:00", "17:00", [progA]);
    expect(await reason(a, progA, "2026-01-12 10:00+02")).toBeNull();
    expect(await reason(a, progA, "2026-01-12 16:59+02")).toBeNull();
    expect(await reason(a, progA, "2026-01-12 17:00+02")).toBe("off_shift");
    expect(await reason(a, progA, "2026-01-12 08:59+02")).toBe("off_shift");
    expect(await reason(a, progA, "2026-01-13 10:00+02")).toBe("off_shift"); // Tuesday
    await admin("update public.profiles set active = false where id = $1", [a.id]);
  });

  it("overnight shift runs past midnight into the next day", async () => {
    const a = await agent("Night Agent", 901);
    await shift(a, 1, "22:00", "02:00", [progA]); // Monday night
    expect(await reason(a, progA, "2026-01-12 23:30+02")).toBeNull();
    expect(await reason(a, progA, "2026-01-13 01:59+02")).toBeNull(); // Tuesday early hours
    expect(await reason(a, progA, "2026-01-13 02:00+02")).toBe("off_shift");
    expect(await reason(a, progA, "2026-01-12 21:59+02")).toBe("off_shift");
    expect(await reason(a, progA, "2026-01-12 01:00+02")).toBe("off_shift"); // Monday early hours belong to Sunday's shift
    await admin("update public.profiles set active = false where id = $1", [a.id]);
  });

  it("uses Cairo local time in summer (UTC+3) as well", async () => {
    const a = await agent("Summer Agent", 902);
    await shift(a, 1, "09:00", "17:00", [progA]);
    expect(await reason(a, progA, "2026-07-13 06:30+00")).toBeNull(); // 09:30 Cairo, Monday
    expect(await reason(a, progA, "2026-07-13 05:30+00")).toBe("off_shift"); // 08:30 Cairo
    await admin("update public.profiles set active = false where id = $1", [a.id]);
  });
});

describe("eligibility reasons", () => {
  let a: TestUser;
  beforeAll(async () => {
    a = await agent("Reasons Agent", 903);
    await shift(a, 1, "09:00", "17:00", [progA]);
  });
  afterAll(async () => {
    await admin("update public.profiles set active = false where id = $1", [a.id]);
  });

  it("program not on the current shift", async () => {
    expect(await reason(a, progB, MON_10)).toBe("program_not_on_shift");
  });

  it("overlapping shifts of one agent count once and combine programs", async () => {
    await shift(a, 1, "08:00", "12:00", [progB]);
    expect(await reason(a, progB, MON_10)).toBeNull();
    expect(await reason(a, progA, MON_10)).toBeNull();
    expect(await reason(a, progB, "2026-01-12 13:00+02")).toBe("program_not_on_shift");
  });

  it("leave covers whole Cairo days, inclusive", async () => {
    const [{ id }] = await as(manager, (q) => q<{ id: string }>("select public.save_time_off($1, '2026-01-12', '2026-01-12', 'Exam') as id", [a.id]));
    expect(await reason(a, progA, MON_10)).toBe("on_leave");
    expect(await reason(a, progA, "2026-01-19 10:00+02")).toBeNull(); // next Monday
    await as(manager, (q) => q("select public.delete_time_off($1)", [id]));
    expect(await reason(a, progA, MON_10)).toBeNull();
  });

  it("paused, inactive and lead cap", async () => {
    await admin("update public.profiles set paused = true where id = $1", [a.id]);
    expect(await reason(a, progA, MON_10)).toBe("paused");
    await admin("update public.profiles set paused = false, max_open_leads = 1 where id = $1", [a.id]);
    const q = await waiting(progA);
    await admin("update public.inquiries set sales_owner_id = $2 where id = $1", [q, a.id]);
    // Cap is ignored until the manager turns caps on.
    expect(await reason(a, progA, MON_10)).toBeNull();
    await admin("update public.app_settings set per_agent_lead_cap_enabled = true");
    expect(await reason(a, progA, MON_10)).toBe("at_capacity");
    await admin("update public.app_settings set per_agent_lead_cap_enabled = false");
    await admin("update public.profiles set max_open_leads = null where id = $1", [a.id]);
    await admin("update public.profiles set active = false where id = $1", [a.id]);
    expect(await reason(a, progA, MON_10)).toBe("inactive");
    await admin("update public.profiles set active = true where id = $1", [a.id]);
  });

  it("support and manager accounts never receive leads", async () => {
    const s = await createUser("support", "Not Sales");
    expect(await reason(s, progA, MON_10)).toBe("not_sales");
  });
});

describe("round-robin", () => {
  let prog: string;
  let A: TestUser, B: TestUser, C: TestUser;
  beforeAll(async () => {
    prog = await newProgram("RRONE");
    A = await agent("RR Alpha", 1);
    B = await agent("RR Bravo", 2);
    C = await agent("RR Charlie", 3);
    for (const u of [A, B, C]) await shift(u, 1, "09:00", "17:00", [prog]);
  });

  it("goes A → B → C → A", async () => {
    const got = [];
    for (let i = 0; i < 4; i++) got.push(await assign(await waiting(prog), MON_10));
    expect(got).toEqual([A.id, B.id, C.id, A.id]);
  });

  it("skips an ineligible agent, who keeps their place", async () => {
    // Pointer is at A. B is paused → C, then A.
    await admin("update public.profiles set paused = true where id = $1", [B.id]);
    expect(await assign(await waiting(prog), MON_10)).toBe(C.id);
    expect(await assign(await waiting(prog), MON_10)).toBe(A.id);
    await admin("update public.profiles set paused = false where id = $1", [B.id]);
    expect(await assign(await waiting(prog), MON_10)).toBe(B.id); // back in turn, not jumped ahead
    expect(await assign(await waiting(prog), MON_10)).toBe(C.id);
  });

  it("manual reassignment does not move the rotation pointer", async () => {
    const q = await waiting(prog);
    await as(manager, (x) => x("select public.reassign_inquiry($1, $2, 'Speaks to this family')", [q, C.id]));
    expect(await owner(q)).toBe(C.id);
    // Last round-robin pick was C, so A is next — the manual assignment to C changed nothing.
    expect(await assign(await waiting(prog), MON_10)).toBe(A.id);
    const [m] = await admin<{ assignment_method: string }>("select assignment_method from public.inquiries where id = $1", [q]);
    expect(m.assignment_method).toBe("manual");
  });

  it("is per program", async () => {
    const other = await newProgram("RRTWO");
    await shift(C, 1, "09:00", "17:00", [other]);
    await shift(B, 1, "09:00", "17:00", [other]);
    // Program RRTWO starts its own rotation: lowest order first.
    expect(await assign(await waiting(other), MON_10)).toBe(B.id);
    expect(await assign(await waiting(other), MON_10)).toBe(C.id);
    expect(await assign(await waiting(other), MON_10)).toBe(B.id);
  });

  it("never reassigns an inquiry that already has an owner", async () => {
    const q = await waiting(prog);
    const first = await assign(q, MON_10);
    expect(first).not.toBeNull();
    expect(await assign(q, MON_10)).toBeNull();
    const [{ n: count }] = await admin<{ n: number }>(
      "select count(*)::int as n from public.activities where inquiry_id = $1 and type = 'owner_change'", [q]);
    expect(count).toBe(1);
  });

  it("writes the timeline entry as the system and notifies the agent", async () => {
    const q = await waiting(prog);
    const to = await assign(q, MON_10);
    const [act] = await admin<{ actor_id: string | null; body: string }>(
      "select actor_id, body from public.activities where inquiry_id = $1 and type = 'owner_change'", [q]);
    expect(act).toEqual({ actor_id: null, body: "Assigned automatically (round-robin)" });
    const notes = await admin("select 1 from public.notifications where user_id = $1 and inquiry_id = $2", [to, q]);
    expect(notes).toHaveLength(1);
  });

  it("rotation order can be changed by the manager and the pointer follows the last agent", async () => {
    const sales = await admin<{ id: string }>("select id from public.profiles where role = 'sales' order by rotation_order, created_at");
    const ids = sales.map((s) => s.id).filter((id) => ![A.id, B.id, C.id].includes(id));
    // New order: C, A, B (others after them).
    await as(manager, (q) => q("select public.set_rotation_order($1)", [[C.id, A.id, B.id, ...ids]]));
    // Last pick in this program was A (see "never reassigns") or B/C — check the sequence is consistent with the new order.
    const picks = [];
    for (let i = 0; i < 3; i++) picks.push(await assign(await waiting(prog), MON_10));
    const order = [C.id, A.id, B.id];
    const start = order.indexOf(picks[0]!);
    expect(picks).toEqual([0, 1, 2].map((k) => order[(start + k) % 3]));
    await expectError(as(manager, (q) => q("select public.set_rotation_order($1)", [[C.id]])), "CRM01", "every sales agent");
  });
});

describe("waiting queue and runs", () => {
  it("waits when nobody is eligible, then assigns oldest first", async () => {
    const prog = await newProgram("QUEUE");
    const older = await waiting(prog, 30);
    const newer = await waiting(prog, 5);
    const r1 = (await admin<{ r: { assigned: number; waiting: number } }>("select private.assign_waiting($1) as r", [MON_10]))[0].r;
    expect(await owner(older)).toBeNull();
    expect(r1.waiting).toBeGreaterThanOrEqual(2);

    const a = await agent("Queue Agent", 50);
    await shift(a, 1, "09:00", "17:00", [prog]);
    await admin("update public.profiles set max_open_leads = 1 where id = $1", [a.id]);
    await admin("update public.app_settings set per_agent_lead_cap_enabled = true");
    await admin("select private.assign_waiting($1)", [MON_10]);
    await admin("update public.app_settings set per_agent_lead_cap_enabled = false");
    expect(await owner(older)).toBe(a.id); // oldest got the only free slot
    expect(await owner(newer)).toBeNull();
    await admin("update public.profiles set active = false where id = $1", [a.id]);
  });

  it("two runs at the same moment never assign one inquiry twice", async () => {
    const prog = await newProgram("RACE");
    const X = await agent("Race X", 70);
    const Y = await agent("Race Y", 71);
    for (const u of [X, Y]) await shift(u, 1, "09:00", "17:00", [prog]);
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(await waiting(prog, 60 - i));
    await Promise.all([
      admin("select private.assign_waiting($1)", [MON_10]),
      admin("select private.assign_waiting($1)", [MON_10]),
      admin("select private.assign_waiting($1)", [MON_10]),
    ]);
    const rows = await admin<{ sales_owner_id: string; n: number }>(
      `select i.sales_owner_id, (select count(*)::int from public.activities a where a.inquiry_id = i.id and a.type = 'owner_change') as n
       from public.inquiries i where i.id = any($1)`, [ids]);
    expect(rows.every((r) => r.sales_owner_id && r.n === 1)).toBe(true);
    const perAgent = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.sales_owner_id]: (acc[r.sales_owner_id] ?? 0) + 1 }), {});
    expect(perAgent).toEqual({ [X.id]: 5, [Y.id]: 5 });
    for (const u of [X, Y]) await admin("update public.profiles set active = false where id = $1", [u.id]);
  });

  it("a pause ends when the agent's shift ends", async () => {
    const a = await agent("Pause Agent", 80);
    await shift(a, 1, "09:00", "17:00", [progB]);
    await as(a, (q) => q("select public.set_user_paused($1, true)", [a.id]));
    await admin("select private.assign_waiting($1)", [MON_10]); // on shift: stays paused
    expect((await admin<{ paused: boolean }>("select paused from public.profiles where id = $1", [a.id]))[0].paused).toBe(true);
    await admin("select private.assign_waiting($1)", ["2026-01-12 17:05+02"]); // after shift
    expect((await admin<{ paused: boolean }>("select paused from public.profiles where id = $1", [a.id]))[0].paused).toBe(false);
    await admin("update public.profiles set active = false where id = $1", [a.id]);
  });

  it("managers are told when leads wait with nobody on shift, at most hourly", async () => {
    const prog = await newProgram("ALERT");
    await waiting(prog, 30);
    await admin("select private.assign_waiting(now())");
    await admin("select private.assign_waiting(now() + interval '2 minutes')");
    const notes = await admin<{ text: string }>("select text from public.notifications where user_id = $1 and text like '%ALERT%'", [manager.id]);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toMatch(/no sales agent is on shift for ALERT/);
  });

  it("a manager-created lead is assigned immediately when someone is on shift", async () => {
    const prog = await newProgram("NOWAS");
    const a = await agent("Always Agent", 90);
    await alwaysOn(a, [prog]);
    const phone = newPhone();
    const r = await as(manager, async (q) => (await q<{ r: { queued: boolean; owner_id: string } }>(
      "select public.create_inquiry($1) as r", [{ name: "Walk-in", phone, phone_normalized: phone, program_id: prog }]))[0].r);
    expect(r).toMatchObject({ queued: false, owner_id: a.id });
    await admin("update public.profiles set active = false where id = $1", [a.id]);
  });

  it("redistributes a leaving agent's open leads to colleagues", async () => {
    const prog = await newProgram("REDIS");
    const leaving = await agent("Leaving Agent", 95);
    const staying = await agent("Staying Agent", 96);
    await alwaysOn(staying, [prog]);
    const q1 = await waiting(prog);
    await admin("update public.inquiries set sales_owner_id = $2 where id = $1", [q1, leaving.id]);
    await admin(
      "insert into public.follow_ups (inquiry_id, owner_id, due_at, note, created_by) values ($1, $2, now() + interval '1 day', 'Call back', $2)",
      [q1, leaving.id]);
    await as(manager, (q) => q("select public.set_user_active($1, false, true)", [leaving.id]));
    expect(await owner(q1)).toBe(staying.id);
    const [fu] = await admin<{ owner_id: string }>("select owner_id from public.follow_ups where inquiry_id = $1", [q1]);
    expect(fu.owner_id).toBe(staying.id); // the follow-up moved with the lead
    await admin("update public.profiles set active = false where id = $1", [staying.id]);
  });
});

describe("permissions", () => {
  it("only managers manage shifts, leave, rotation and runs", async () => {
    const s = await agent("Perm Agent", 99);
    await expectError(as(s, (q) => q("select public.save_shift($1)", [{ user_id: s.id, weekday: 1, start: "09:00", end: "17:00", program_ids: [progA] }])), "CRM03");
    await expectError(as(s, (q) => q("select public.save_time_off($1, '2026-01-01', '2026-01-02', 'x')", [s.id])), "CRM03");
    await expectError(as(s, (q) => q("select public.run_assignment()")), "CRM03");
    await expectError(as(s, (q) => q("select * from public.eligibility_now()")), "CRM03");
    await expectError(as(s, (q) => q("select public.redistribute_open_leads($1, 'x')", [s.id])), "CRM03");
    // Staff cannot call the internal assignment functions at all.
    await expectError(as(s, (q) => q("select private.assign_waiting(now())")), "42501");
    await expectError(as(manager, (q) => q("select private.assign_next(gen_random_uuid(), now())")), "42501");
  });

  it("agents see only their own shifts; managers see all", async () => {
    const s1 = await agent("Shift Viewer 1", 101);
    const s2 = await agent("Shift Viewer 2", 102);
    await shift(s1, 2, "09:00", "12:00", [progA]);
    await shift(s2, 2, "09:00", "12:00", [progA]);
    const seen = await as(s1, (q) => q<{ user_id: string }>("select distinct user_id from public.shifts"));
    expect(seen.map((r) => r.user_id)).toEqual([s1.id]);
    const all = await as(manager, (q) => q<{ user_id: string }>("select distinct user_id from public.shifts where user_id = any($1)", [[s1.id, s2.id]]));
    expect(all).toHaveLength(2);
  });

  it("shift input is validated", async () => {
    const s = await agent("Validate Agent", 103);
    await expectError(as(manager, (q) => q("select public.save_shift($1)", [{ user_id: s.id, weekday: 1, start: "9am", end: "17:00", program_ids: [progA] }])), "CRM01", "HH:MM");
    await expectError(as(manager, (q) => q("select public.save_shift($1)", [{ user_id: s.id, weekday: 1, start: "09:00", end: "17:00", program_ids: [] }])), "CRM01", "at least one program");
    await expectError(as(manager, (q) => q("select public.save_shift($1)", [{ user_id: manager.id, weekday: 1, start: "09:00", end: "17:00", program_ids: [progA] }])), "CRM01", "sales agents");
  });
});
