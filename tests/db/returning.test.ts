/**
 * Step 1 (22 Oct 2026): returning customers go to their previous agent, phone matching on
 * main or second number, and "not opened yet" tracking for inquiries and onboardings.
 * Own programs and agents, so other test files never interfere. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createUser, expectError, newPhone, type TestUser } from "./helpers";

const MON_10 = "2026-01-12 10:00+02"; // Monday 10:00 Cairo

let manager: TestUser;
let progX: string; // RETX
let progY: string; // RETY
let n = 0;

async function newProgram(code: string): Promise<string> {
  const [p] = await admin<{ id: string }>("insert into public.programs (code, name) values ($1, $1) returning id", [code]);
  await admin("insert into public.rotation_state (program_id) values ($1) on conflict do nothing", [p.id]);
  return p.id;
}
async function agent(name: string, order: number, programs: string[] = [], alwaysOn = false): Promise<TestUser> {
  const u = await createUser("sales", name);
  await admin("update public.profiles set rotation_order = $2 where id = $1", [u.id, order]);
  if (alwaysOn) {
    for (let d = 0; d < 7; d++) {
      await as(manager, (q) => q("select public.save_shift($1)", [{ user_id: u.id, weekday: d, start: "00:00", end: "00:00", program_ids: programs }]));
    }
  }
  return u;
}
/** A Saturday-only shift: the agent sells these programs but is off shift on Monday 10:00. */
async function sells(user: TestUser, programs: string[]) {
  await as(manager, (q) => q("select public.save_shift($1)", [{ user_id: user.id, weekday: 6, start: "09:00", end: "10:00", program_ids: programs }]));
}
async function contact(phone = newPhone(), secondary: string | null = null): Promise<string> {
  const [c] = await admin<{ id: string }>(
    "insert into public.contacts (name, phone, phone_normalized, phone_secondary, phone_secondary_normalized) values ($1, $2, $2, $3, $3) returning id",
    [`Returning ${++n}`, phone, secondary]);
  return c.id;
}
/** An inquiry created directly (no auto-assignment), optionally already owned. */
async function inquiry(contactId: string, program: string, ownerId: string | null = null, createdAt = "now()"): Promise<string> {
  const [i] = await admin<{ id: string }>(
    `insert into public.inquiries (contact_id, program_id, stage_id, source, sales_owner_id, assigned_at, created_at)
     values ($1, $2, (select id from public.stages where system_key = 'new'), 'manual', $3, case when $3::uuid is not null then now() end, ${createdAt}) returning id`,
    [contactId, program, ownerId]);
  return i.id;
}
const assign = async (inq: string, when = MON_10) => (await admin<{ a: string | null }>("select private.assign_next($1, $2) as a", [inq, when]))[0].a;
const row = async (inq: string) =>
  (await admin<{ sales_owner_id: string | null; assignment_method: string | null; owner_opened_at: Date | null }>(
    "select sales_owner_id, assignment_method, owner_opened_at from public.inquiries where id = $1", [inq]))[0];
const notes = async (user: TestUser) =>
  (await admin<{ text: string; inquiry_id: string | null }>("select text, inquiry_id from public.notifications where user_id = $1 order by created_at", [user.id]));
const rotation = async (program: string) =>
  (await admin<{ last_user_id: string | null }>("select last_user_id from public.rotation_state where program_id = $1", [program]))[0].last_user_id;

beforeAll(async () => {
  manager = await createUser("manager", "Returning Manager");
  progX = await newProgram("RETX");
  progY = await newProgram("RETY");
});
afterAll(closeDb);

describe("returning customers go to their previous agent", () => {
  it("assigns to the previous owner, notifies them, and does not use up a rotation turn", async () => {
    const prev = await agent("Prev Owner", 2001);
    await sells(prev, [progX, progY]); // off shift on Monday 10:00
    const other = await agent("On Shift Agent", 2002, [progX, progY], true);
    const c = await contact();
    await inquiry(c, progY, prev.id, "now() - interval '200 days'");
    const before = await rotation(progX);

    const fresh = await inquiry(c, progX);
    expect(await assign(fresh)).toBe(prev.id);
    const r = await row(fresh);
    expect(r.sales_owner_id).toBe(prev.id);
    expect(r.assignment_method).toBe("returning");
    expect(r.owner_opened_at).toBeNull();
    expect(await rotation(progX)).toBe(before); // the on-shift agent keeps their turn

    const msg = (await notes(prev)).find((x) => x.inquiry_id === fresh);
    expect(msg?.text).toMatch(/^Returning customer assigned to you: Returning \d+ \(RETX\)\. They had a lead with you before \(RETY, [A-Z][a-z]{2} \d{4}\)\.$/);
    const [act] = await admin<{ body: string; method: string }>(
      "select body, meta ->> 'method' as method from public.activities where inquiry_id = $1 and type = 'owner_change'", [fresh]);
    expect(act).toEqual({ body: "Assigned to the previous agent (returning customer)", method: "returning" });
    expect((await notes(other)).some((x) => x.inquiry_id === fresh)).toBe(false);
    await admin("update public.profiles set active = false where id = $1", [other.id]);
  });

  it("uses the owner of the most recent earlier inquiry", async () => {
    const older = await agent("Older Owner", 2011);
    const newer = await agent("Newer Owner", 2012);
    await sells(older, [progX]);
    await sells(newer, [progX]);
    const c = await contact();
    await inquiry(c, progY, older.id, "now() - interval '400 days'");
    await inquiry(c, progY, newer.id, "now() - interval '30 days'");
    expect(await assign(await inquiry(c, progX))).toBe(newer.id);
  });

  it("also goes to the previous owner when they are paused or at their lead limit", async () => {
    const prev = await agent("Busy Owner", 2021, [progX], true);
    await admin("update public.profiles set paused = true where id = $1", [prev.id]);
    const c = await contact();
    await inquiry(c, progY, prev.id, "now() - interval '10 days'");
    expect(await assign(await inquiry(c, progX))).toBe(prev.id);
    await admin("update public.profiles set paused = false, active = false where id = $1", [prev.id]);
  });

  it("previous agent does not sell this program: the normal turn order applies", async () => {
    const prev = await agent("Other Program Owner", 2026);
    await sells(prev, [progY]); // sells RETY only
    const onShift = await agent("X Seller", 2027, [progX], true);
    const c = await contact();
    await inquiry(c, progY, prev.id, "now() - interval '10 days'");
    const fresh = await inquiry(c, progX);
    expect(await assign(fresh)).toBe(onShift.id);
    expect((await row(fresh)).assignment_method).toBe("round_robin");
    await admin("update public.profiles set active = false where id in ($1, $2)", [prev.id, onShift.id]);
  });

  it("on leave: the normal turn order applies", async () => {
    const prev = await agent("Leave Owner", 2031);
    await sells(prev, [progX]);
    const onShift = await agent("Covering Agent", 2032, [progX], true);
    const day = new Date().toISOString().slice(0, 10);
    await as(manager, (q) => q("select public.save_time_off($1, $2, $2, 'Holiday')", [prev.id, day]));
    const c = await contact();
    await inquiry(c, progY, prev.id, "now() - interval '10 days'");
    const fresh = await inquiry(c, progX);
    expect(await assign(fresh, new Date().toISOString())).toBe(onShift.id);
    expect((await row(fresh)).assignment_method).toBe("round_robin");
    await admin("update public.profiles set active = false where id in ($1, $2)", [prev.id, onShift.id]);
  });

  it("previous agent deactivated: normal turn order, and managers are told once", async () => {
    const prev = await agent("Former Agent", 2041);
    const onShift = await agent("Next Agent", 2042, [progX], true);
    const c = await contact();
    await inquiry(c, progY, prev.id, "now() - interval '10 days'");
    await admin("update public.profiles set active = false where id = $1", [prev.id]);
    const fresh = await inquiry(c, progX);
    expect(await assign(fresh)).toBe(onShift.id);
    const m = (await notes(manager)).filter((x) => x.inquiry_id === fresh);
    expect(m).toHaveLength(1);
    expect(m[0].text).toContain("their previous agent Former Agent is no longer an active sales agent");
    await admin("update public.profiles set active = false where id = $1", [onShift.id]);
  });

  it("a brand-new customer still goes by turn order", async () => {
    const onShift = await agent("Turn Agent", 2051, [progX], true);
    const fresh = await inquiry(await contact(), progX);
    expect(await assign(fresh)).toBe(onShift.id);
    expect((await row(fresh)).assignment_method).toBe("round_robin");
    await admin("update public.profiles set active = false where id = $1", [onShift.id]);
  });

  it("works for a manual Add customer left to automatic assignment", async () => {
    const prev = await agent("Manual Prev", 2061);
    await sells(prev, [progX]);
    const phone = newPhone();
    const c = await contact(phone);
    await inquiry(c, progY, prev.id, "now() - interval '5 days'");
    const r = await as(manager, async (q) => (await q<{ r: { inquiry_id: string; owner_id: string; matched_existing: boolean } }>(
      "select public.create_inquiry($1) as r", [{ name: "Walk-in again", phone, phone_normalized: phone, program_id: progX }]))[0].r);
    expect(r.matched_existing).toBe(true);
    expect(r.owner_id).toBe(prev.id);
    expect((await row(r.inquiry_id)).assignment_method).toBe("returning");
  });

  it("a manager's explicit choice and an agent's own new customer are kept", async () => {
    const prev = await agent("Kept Prev", 2071);
    const chosen = await agent("Chosen Agent", 2072);
    const phone = newPhone();
    const c = await contact(phone);
    await inquiry(c, progY, prev.id, "now() - interval '5 days'");
    const r = await as(manager, async (q) => (await q<{ r: { inquiry_id: string; owner_id: string } }>(
      "select public.create_inquiry($1) as r", [{ name: "Chosen", phone, phone_normalized: phone, program_id: progX, assign_to: chosen.id }]))[0].r);
    expect(r.owner_id).toBe(chosen.id);
    const own = await as(chosen, async (q) => (await q<{ r: { inquiry_id: string; owner_id: string } }>(
      "select public.create_inquiry($1) as r", [{ name: "Mine", phone, phone_normalized: phone, program_id: progX, student_name: "Sibling" }]))[0].r);
    expect(own.owner_id).toBe(chosen.id);
  });
});

describe("matching phone numbers", () => {
  it("a new lead whose phone is a saved customer's second number joins that customer", async () => {
    const main = newPhone();
    const second = newPhone();
    const c = await contact(main, second);
    const r = await as(manager, async (q) => (await q<{ r: { inquiry_id: string; matched_existing: boolean } }>(
      "select public.create_inquiry($1) as r", [{ name: "Called from 2nd phone", phone: second, phone_normalized: second, program_id: progX }]))[0].r);
    expect(r.matched_existing).toBe(true);
    const [i] = await admin<{ contact_id: string }>("select contact_id from public.inquiries where id = $1", [r.inquiry_id]);
    expect(i.contact_id).toBe(c);
  });

  it("a new lead's second number matching a saved main number joins that customer", async () => {
    const main = newPhone();
    const c = await contact(main);
    const fresh = newPhone();
    const r = await as(manager, async (q) => (await q<{ r: { inquiry_id: string; matched_existing: boolean } }>(
      "select public.create_inquiry($1) as r", [{ name: "New number", phone: fresh, phone_normalized: fresh, phone_secondary: main, phone_secondary_normalized: main, program_id: progX }]))[0].r);
    expect(r.matched_existing).toBe(true);
    expect((await admin<{ contact_id: string }>("select contact_id from public.inquiries where id = $1", [r.inquiry_id]))[0].contact_id).toBe(c);
  });

  it("a different number makes a new customer", async () => {
    await contact(newPhone(), newPhone());
    const r = await as(manager, async (q) => (await q<{ r: { matched_existing: boolean } }>(
      "select public.create_inquiry($1) as r", [{ name: "Someone new", phone: newPhone(), phone_normalized: newPhone(), program_id: progX }]))[0].r);
    expect(r.matched_existing).toBe(false);
  });
});

describe("not opened yet", () => {
  it("only the owner opening the lead clears it; a new owner starts unopened again", async () => {
    const a = await agent("Opener A", 2101);
    const b = await agent("Opener B", 2102);
    const inq = await inquiry(await contact(), progX);
    await as(manager, (q) => q("select public.reassign_inquiry($1, $2, 'Test')", [inq, a.id]));
    expect((await row(inq)).owner_opened_at).toBeNull();

    // A manager or another agent opening it does not count.
    expect((await as(manager, (q) => q<{ ok: boolean }>("select public.mark_inquiry_opened($1) as ok", [inq])))[0].ok).toBe(false);
    expect((await as(b, (q) => q<{ ok: boolean }>("select public.mark_inquiry_opened($1) as ok", [inq])))[0].ok).toBe(false);
    expect((await row(inq)).owner_opened_at).toBeNull();

    const version = (await admin<{ version: number }>("select version from public.inquiries where id = $1", [inq]))[0].version;
    expect((await as(a, (q) => q<{ ok: boolean }>("select public.mark_inquiry_opened($1) as ok", [inq])))[0].ok).toBe(true);
    expect((await row(inq)).owner_opened_at).not.toBeNull();
    expect((await admin<{ version: number }>("select version from public.inquiries where id = $1", [inq]))[0].version).toBe(version); // no edit conflict
    expect((await as(a, (q) => q<{ ok: boolean }>("select public.mark_inquiry_opened($1) as ok", [inq])))[0].ok).toBe(false); // already opened

    await as(manager, (q) => q("select public.reassign_inquiry($1, $2, 'Cover')", [inq, b.id]));
    expect((await row(inq)).owner_opened_at).toBeNull();
  });

  it("an agent's own new customer starts opened", async () => {
    const a = await agent("Self Adder", 2111);
    const r = await as(a, async (q) => (await q<{ r: { inquiry_id: string } }>(
      "select public.create_inquiry($1) as r", [{ name: "Own", phone: newPhone(), phone_normalized: newPhone(), program_id: progX }]))[0].r);
    expect((await row(r.inquiry_id)).owner_opened_at).not.toBeNull();
  });

  it("support: assigned by a manager starts unopened; claiming yourself counts as opened", async () => {
    const s1 = await createUser("support", "Support Opener 1");
    const s2 = await createUser("support", "Support Opener 2");
    const buyer = await agent("Support Test Agent", 2121);
    const inq = await inquiry(await contact(), progX, buyer.id);
    const [{ id: course }] = await admin<{ id: string }>(
      "insert into public.courses (program_id, name, price, currency) values ($1, 'RET course', 1000, 'EGP') returning id", [progX]);
    const [{ id: enr }] = await admin<{ id: string }>(
      "insert into public.enrollments (inquiry_id, course_id, agreed_total, currency, original_sales_owner_id, created_by) values ($1, $2, 1000, 'EGP', $3, $3) returning id", [inq, course, buyer.id]);
    const [{ id: ob }] = await admin<{ id: string }>("insert into public.onboardings (enrollment_id) values ($1) returning id", [enr]);
    const opened = async () => (await admin<{ t: Date | null }>("select support_opened_at as t from public.onboardings where id = $1", [ob]))[0].t;

    await as(manager, (q) => q("select public.assign_onboarding($1, $2)", [ob, s1.id]));
    expect(await opened()).toBeNull();
    expect((await as(s2, (q) => q<{ ok: boolean }>("select public.mark_onboarding_opened($1) as ok", [inq])))[0].ok).toBe(false);
    expect((await as(s1, (q) => q<{ ok: boolean }>("select public.mark_onboarding_opened($1) as ok", [inq])))[0].ok).toBe(true);
    expect(await opened()).not.toBeNull();

    await as(manager, (q) => q("select public.assign_onboarding($1, $2, 'Cover')", [ob, s2.id]));
    expect(await opened()).toBeNull();
  });

  it("signed-out visitors cannot mark anything opened", async () => {
    const inq = await inquiry(await contact(), progX);
    await expectError(as(null, (q) => q("select public.mark_inquiry_opened($1)", [inq])), "42501");
    await expectError(as(null, (q) => q("select public.mark_onboarding_opened($1)", [inq])), "42501");
  });
});
