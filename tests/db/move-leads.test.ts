/**
 * CRM changes, Part A (26 Oct 2026): managers move many leads at once — to one agent, shared across
 * several, swapped between two, or back to the queue. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createInquiry, createUser, expectError, type TestUser } from "./helpers";

let manager: TestUser, nour: TestUser, youssef: TestUser, mariam: TestUser, leaver: TestUser, support: TestUser, accountant: TestUser;

async function leadsOf(owner: TestUser, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = (await createInquiry(owner, { name: `Move Lead ${owner.name} ${i}` })).inquiry_id;
    await admin("update public.inquiries set sales_owner_id = $2 where id = $1", [id, owner.id]);
    ids.push(id);
  }
  return ids;
}
const ownersOf = async (ids: string[]) =>
  (await admin<{ id: string; sales_owner_id: string | null }>("select id, sales_owner_id from public.inquiries where id = any($1)", [ids]))
    .reduce<Record<string, string | null>>((m, r) => ({ ...m, [r.id]: r.sales_owner_id }), {});
const move = (user: TestUser, p: Record<string, unknown>) =>
  as(user, async (q) => (await q<{ r: { moved: number; queued: number; skipped: number; agents: { name: string; received: number; open: number; cap: number | null }[] } }>(
    "select public.move_leads($1) as r", [{ reason: "Nour is on leave this week", ...p }]))[0].r);
const notes = (user: TestUser) =>
  admin<{ text: string; inquiry_id: string | null; kind: string }>("select text, inquiry_id, kind from public.notifications where user_id = $1 order by created_at", [user.id]);

beforeAll(async () => {
  manager = await createUser("manager", "Move Manager");
  nour = await createUser("sales", "Move Nour");
  youssef = await createUser("sales", "Move Youssef");
  mariam = await createUser("sales", "Move Mariam");
  leaver = await createUser("sales", "Move Leaver");
  support = await createUser("support", "Move Support");
  accountant = await createUser("accountant", "Move Accountant");
});
afterAll(async () => {
  await admin("update public.profiles set active = false where id = any($1)", [[nour.id, youssef.id, mariam.id, leaver.id, support.id, accountant.id]]);
  await admin("update public.profiles set active = false where id = $1", [manager.id]).catch(() => {});
  await closeDb();
});

describe("moving chosen leads", () => {
  it("moves them to one agent in one step, with follow-ups, timeline, one notification each side and one audit line", async () => {
    const ids = await leadsOf(nour, 3);
    await as(nour, (q) => q("select public.create_follow_up($1, now() + interval '1 day', 'Call back about the price')", [ids[0]]));
    await admin("delete from public.notifications where user_id = any($1)", [[nour.id, youssef.id]]);

    const r = await move(manager, { ids, mode: "to", to: [youssef.id] });
    expect(r.moved).toBe(3);
    expect(Object.values(await ownersOf(ids))).toEqual([youssef.id, youssef.id, youssef.id]);
    const [m] = await admin<{ assignment_method: string; n: number }>(
      "select assignment_method, (select count(*)::int from public.follow_ups f where f.inquiry_id = i.id and f.status = 'open' and f.owner_id = $2) as n from public.inquiries i where i.id = $1", [ids[0], youssef.id]);
    expect(m).toEqual({ assignment_method: "manual", n: 1 }); // the open follow-up moved with the lead
    const [act] = await admin<{ body: string }>("select body from public.activities where inquiry_id = $1 and type = 'owner_change' order by created_at desc limit 1", [ids[1]]);
    expect(act.body).toBe("Moved from Move Nour to Move Youssef by Move Manager: Nour is on leave this week");
    expect((await notes(youssef)).map((n) => [n.text, n.kind])).toEqual([["3 leads moved to you by Move Manager: Nour is on leave this week", "lead_assigned"]]);
    expect((await notes(nour)).map((n) => [n.text, n.kind])).toEqual([["3 of your leads moved to Move Youssef by Move Manager: Nour is on leave this week", "leads_moved_away"]]);
    const [audit] = await admin<{ action: string; target: string }>("select action, target from public.audit_log where action like 'Moved 3 leads%' order by created_at desc limit 1");
    expect(audit).toEqual({ action: "Moved 3 leads (Nour is on leave this week)", target: "Move Youssef +3" });
  });

  it("a single lead gets the usual one-lead notification with a link to it", async () => {
    const [id] = await leadsOf(nour, 1);
    await admin("delete from public.notifications where user_id = $1", [mariam.id]);
    await move(manager, { ids: [id], mode: "to", to: [mariam.id] });
    const [n] = await notes(mariam);
    expect(n.text).toMatch(/^Lead reassigned to you: Move Lead/);
    expect(n.inquiry_id).toBe(id);
  });

  it("shares leads across several agents in turn; leads already with one of them stay put", async () => {
    const ids = await leadsOf(leaver, 5);
    const [keep] = await leadsOf(mariam, 1);
    const r = await move(manager, { ids: [...ids, keep], mode: "share", to: [nour.id, youssef.id] });
    expect(r.moved).toBe(6);
    const o = await ownersOf(ids);
    expect(ids.map((i) => o[i])).toEqual([nour.id, youssef.id, nour.id, youssef.id, nour.id]);
    expect((await ownersOf([keep]))[keep]).toBe(youssef.id); // Mariam was not chosen, so her lead is shared too (6th in turn)
    const again = await move(manager, { ids, mode: "share", to: [nour.id, youssef.id] });
    expect([again.moved, again.skipped]).toEqual([0, 5]); // already with the chosen agents: nothing to do
  });

  it("returns open leads to the queue; enrolled or lost ones cannot go back", async () => {
    const ids = await leadsOf(nour, 2);
    const r = await move(manager, { ids, mode: "queue" });
    expect(r.queued).toBe(2);
    expect(Object.values(await ownersOf(ids))).toEqual([null, null]);
    const [lost] = await leadsOf(nour, 1);
    await admin("update public.inquiries set stage_id = (select id from public.stages where system_key = 'lost') where id = $1", [lost]);
    await expectError(move(manager, { ids: [lost], mode: "queue" }), "CRM01", "cannot go back to the queue");
    await move(manager, { ids: [lost], mode: "to", to: [youssef.id] });
    expect((await ownersOf([lost]))[lost]).toBe(youssef.id);
  });

  it("reports each receiving agent's open leads against their cap", async () => {
    await admin("update public.profiles set max_open_leads = 2 where id = $1", [mariam.id]);
    const ids = await leadsOf(leaver, 3);
    const r = await move(manager, { ids, mode: "to", to: [mariam.id] });
    const m = r.agents.find((a) => a.name === "Move Mariam")!;
    expect(m.received).toBe(3);
    expect(m.cap).toBe(2);
    expect(m.open).toBeGreaterThan(2);
    await admin("update public.profiles set max_open_leads = null where id = $1", [mariam.id]);
  });

  it("is all or nothing, and checks what is asked", async () => {
    const ids = await leadsOf(nour, 2);
    await expectError(move(manager, { ids: [...ids, "00000000-0000-4000-8000-000000000000"], mode: "to", to: [youssef.id] }), "CRM04");
    expect(Object.values(await ownersOf(ids))).toEqual([nour.id, nour.id]);
    await expectError(move(manager, { ids, mode: "to", to: [support.id] }), "CRM01", "active sales agents");
    await admin("update public.profiles set active = false where id = $1", [leaver.id]);
    await expectError(move(manager, { ids, mode: "to", to: [leaver.id] }), "CRM01", "active sales agents");
    await expectError(move(manager, { ids, mode: "to", to: [youssef.id], reason: "  " }), "CRM01", "Add a reason");
    await expectError(move(manager, { ids, mode: "share", to: [youssef.id] }), "CRM01", "at least two agents");
    await expectError(move(manager, { ids: [], mode: "to", to: [youssef.id] }), "CRM01", "at least one lead");
    const many = Array.from({ length: 501 }, () => "00000000-0000-4000-8000-000000000000");
    await expectError(move(manager, { ids: many, mode: "to", to: [youssef.id] }), "CRM01", "up to 500");
    expect(Object.values(await ownersOf(ids))).toEqual([nour.id, nour.id]);
  });

  it("only managers move leads", async () => {
    const ids = await leadsOf(nour, 1);
    for (const user of [nour, support, accountant]) await expectError(move(user, { ids, mode: "to", to: [youssef.id] }), "CRM03");
  });

  it("never changes who is credited for a sale", async () => {
    const [id] = await leadsOf(nour, 1);
    const [{ id: prog }] = await admin<{ id: string }>("select program_id as id from public.inquiries where id = $1", [id]);
    const typeId = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course_type($1) as id", [{ name: "Move Type", color: "blue" }]))[0].id);
    const course = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course($1) as id", [{ program_id: prog, course_type_id: typeId, name: "Move Course", price: 1000, currency: "EGP", delivery: "online" }]))[0].id);
    await as(nour, (q) => q("select public.save_enrollment($1)", [{ inquiry_id: id, course_id: course, agreed_total: 1000 }]));
    await move(manager, { ids: [id], mode: "to", to: [youssef.id] });
    const [e] = await admin<{ original_sales_owner_id: string }>("select original_sales_owner_id from public.enrollments where inquiry_id = $1", [id]);
    expect(e.original_sales_owner_id).toBe(nour.id);
  });
});

describe("swapping leads between two agents", () => {
  it("A's chosen leads go to B and B's to A, in one step", async () => {
    const a = await leadsOf(nour, 2);
    const b = await leadsOf(youssef, 1);
    const r = await as(manager, async (q) => (await q<{ r: { moved: number } }>("select public.swap_leads($1) as r",
      [{ agent_a: nour.id, agent_b: youssef.id, a_ids: a, b_ids: b, reason: "Arabic-speaking families to Youssef" }]))[0].r);
    expect(r.moved).toBe(3);
    const o = await ownersOf([...a, ...b]);
    expect([o[a[0]], o[a[1]], o[b[0]]]).toEqual([youssef.id, youssef.id, nour.id]);
    const [audit] = await admin<{ action: string }>("select action from public.audit_log where action like 'Swapped%' order by created_at desc limit 1");
    expect(audit.action).toBe("Swapped 3 leads (Arabic-speaking families to Youssef)");
  });

  it("refuses leads that are not the named agent's, and the same agent twice", async () => {
    const a = await leadsOf(nour, 1);
    const swap = (p: Record<string, unknown>) => as(manager, (q) => q("select public.swap_leads($1)", [{ reason: "Swap", ...p }]));
    await expectError(swap({ agent_a: youssef.id, agent_b: mariam.id, a_ids: a, b_ids: [] }), "CRM01", "changed owner");
    await expectError(swap({ agent_a: nour.id, agent_b: nour.id, a_ids: a, b_ids: [] }), "CRM01", "two different");
    await expectError(as(nour, (q) => q("select public.swap_leads($1)", [{ agent_a: nour.id, agent_b: youssef.id, a_ids: a, b_ids: [], reason: "x" }])), "CRM03");
  });
});
