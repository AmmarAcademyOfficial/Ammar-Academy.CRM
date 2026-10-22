/**
 * Step 2 (22 Oct 2026): notification rules (on/off and pop-up per type and role), a notification
 * to managers for each new lead, the "not opened yet" alert and follow-up reminders.
 *
 * Shares the database with the other test files running at the same time, so:
 *  - rule switching is tested on a test-only notification type, never on a real one;
 *  - timed alerts run at a fixed time in 2020, so only this file's rows qualify.
 * Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createUser, expectError, newPhone, type TestUser } from "./helpers";

/** Minutes after Monday 2 March 2020, 10:00 Cairo time: long ago, so no other test's rows qualify. */
const at = (mins: number) => new Date(Date.parse("2020-03-02T08:00:00Z") + mins * 60_000).toISOString();

let manager: TestUser;
let manager2: TestUser;
let agentA: TestUser;
let agentB: TestUser;
let program: string;
let n = 0;

async function lead(ownerId: string | null, assignedAt: string, extra: { createdAt?: string; source?: string; createdBy?: string | null } = {}): Promise<string> {
  const [c] = await admin<{ id: string }>("insert into public.contacts (name, phone, phone_normalized) values ($1, $2, $2) returning id", [`Notify ${++n}`, newPhone()]);
  const [i] = await admin<{ id: string }>(
    `insert into public.inquiries (contact_id, program_id, stage_id, source, sales_owner_id, assigned_at, created_at, created_by)
     values ($1, $2, (select id from public.stages where system_key = 'new'), $3, $4, $5, $6, $7) returning id`,
    [c.id, program, extra.source ?? "google_sheet", ownerId, ownerId ? assignedAt : null, extra.createdAt ?? assignedAt, extra.createdBy ?? null]);
  return i.id;
}
const notes = async (user: TestUser, inquiry?: string) =>
  admin<{ text: string; kind: string; popup: boolean; inquiry_id: string | null }>(
    `select text, kind, popup, inquiry_id from public.notifications where user_id = $1 ${inquiry ? "and inquiry_id = $2" : ""} order by created_at`,
    inquiry ? [user.id, inquiry] : [user.id]);
const alerts = async (mins: number) => (await admin<{ r: { unopened: number; reminders: number } }>("select private.send_timed_alerts($1) as r", [at(mins)]))[0].r;

beforeAll(async () => {
  manager = await createUser("manager", "Notify Manager");
  manager2 = await createUser("manager", "Notify Manager 2");
  agentA = await createUser("sales", "Notify Agent A");
  agentB = await createUser("sales", "Notify Agent B");
  const [p] = await admin<{ id: string }>("insert into public.programs (code, name) values ('NTFY', 'Notify program') returning id");
  program = p.id;
  await admin("insert into public.rotation_state (program_id) values ($1) on conflict do nothing", [program]);
  await admin("insert into public.notification_rules (event, role, enabled, popup) values ('zz_test', 'sales', true, true), ('zz_test', 'support', false, true) on conflict do nothing");
});

afterAll(async () => {
  await admin("delete from public.notification_rules where event = 'zz_test'");
  await admin("update public.profiles set active = false where id = any($1)", [[manager.id, manager2.id, agentA.id, agentB.id]]);
  await closeDb();
});

describe("notification types and rules", () => {
  it("every existing notification text gets the right type", async () => {
    const cases: [string, string][] = [
      ["New lead assigned: Sara", "lead_assigned"],
      ["Lead assigned to you: Sara", "lead_assigned"],
      ["Lead reassigned to you: Sara", "lead_assigned"],
      ["Returning customer assigned to you: Sara (IELTS). They had a lead with you before (SAT, 1 Oct).", "returning_customer"],
      ["Returning customer Sara: their previous agent Omar is no longer an active sales agent, so the lead goes to the normal turn order.", "previous_agent_inactive"],
      ["Submitted the form again: Sara", "form_resubmitted"],
      ["Enrolled and handed over to support: Sara", "handed_over"],
      ["Payment to review: Sara · EGP 1,000", "payment_to_review"],
      ["Payment confirmed: Sara · EGP 1,000", "payment_update"],
      ["Payment rejected: Sara · EGP 1,000 (blurry receipt)", "payment_update"],
      ["Payment reversed: Sara · EGP 1,000", "payment_update"],
      ["Customer assigned to you for onboarding: Sara", "support_assigned"],
      ["New customer ready for onboarding: Sara", "new_customer_ready"],
      ["Handed-over customer flagged after a payment reversal: Sara", "customer_flagged"],
      ["3 SAT leads waiting: no sales agent is on shift for SAT.", "no_agent_on_shift"],
      ['Google Sheet "Leads" needs attention: missing column', "sheet_problem"],
      ["Google Sheets stopped syncing: the Google sign-in needs to be reconnected (Settings → Google Sheets Connections).", "sheet_problem"],
      ["Something else", "other"],
    ];
    for (const [text, kind] of cases) {
      const [{ k }] = await admin<{ k: string }>("select private.notification_kind($1) as k", [text]);
      expect(k, text).toBe(kind);
    }
  });

  it("a type switched off for a role is not sent; pop-up follows the rule; unknown types are sent without a pop-up", async () => {
    const support = await createUser("support", "Notify Support");
    await admin("insert into public.notifications (user_id, text, kind) values ($1, 'zz one', 'zz_test'), ($2, 'zz two', 'zz_test')", [agentA.id, support.id]);
    expect((await notes(agentA)).filter((x) => x.text === "zz one")).toEqual([expect.objectContaining({ kind: "zz_test", popup: true })]);
    expect((await notes(support)).filter((x) => x.text === "zz two")).toHaveLength(0);

    await admin("insert into public.notifications (user_id, text) values ($1, 'Something unusual')", [agentA.id]);
    expect((await notes(agentA)).find((x) => x.text === "Something unusual")).toMatchObject({ kind: "other", popup: false });
    await admin("update public.profiles set active = false where id = $1", [support.id]);
  });

  it("managers change rules (recorded in the audit history); others cannot; unknown rules are refused", async () => {
    await as(manager, (q) => q("select public.set_notification_rule('zz_test', 'sales', true, false)"));
    await admin("insert into public.notifications (user_id, text, kind) values ($1, 'zz quiet', 'zz_test')", [agentA.id]);
    expect((await notes(agentA)).find((x) => x.text === "zz quiet")?.popup).toBe(false);

    await as(manager, (q) => q("select public.set_notification_rule('zz_test', 'sales', false, false)"));
    await admin("insert into public.notifications (user_id, text, kind) values ($1, 'zz off', 'zz_test')", [agentA.id]);
    expect((await notes(agentA)).find((x) => x.text === "zz off")).toBeUndefined();

    const audit = await admin<{ details: { event: string; enabled: boolean } }>(
      "select details from public.audit_log where action = 'Changed notification setting' and actor_id = $1 order by created_at", [manager.id]);
    expect(audit.map((a) => a.details.enabled)).toEqual([true, false]);

    await expectError(as(agentA, (q) => q("select public.set_notification_rule('zz_test', 'sales', true, true)")), "CRM03");
    await expectError(as(manager, (q) => q("select public.set_notification_rule('nope', 'sales', true, true)")), "CRM01");
  });

  it("staff can read the rules; signed-out visitors cannot", async () => {
    const rows = await as(agentA, (q) => q<{ event: string }>("select event from public.notification_rules"));
    expect(rows.map((r) => r.event)).toEqual(expect.arrayContaining(["lead_assigned", "new_lead", "followup_due"]));
    await expectError(as(null, (q) => q("select * from public.notification_rules")), "42501");
    await expectError(as(agentA, (q) => q("update public.notification_rules set enabled = false")), "42501");
  });
});

describe("managers hear about each new lead", () => {
  it("every active manager gets one, with the program and where it came from", async () => {
    const now = new Date().toISOString();
    const inq = await lead(null, now, { createdAt: now });
    for (const m of [manager, manager2]) {
      const mine = await notes(m, inq);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ kind: "new_lead", popup: true });
      expect(mine[0].text).toMatch(/^New lead: Notify \d+ \(NTFY, Google Sheet\)$/);
    }
    expect(await notes(agentA, inq)).toHaveLength(0);
  });

  it("not to the manager who added it, and not for old rows from a first sheet sync", async () => {
    const now = new Date().toISOString();
    const typed = await lead(null, now, { createdAt: now, source: "manual", createdBy: manager.id });
    expect(await notes(manager, typed)).toHaveLength(0);
    expect((await notes(manager2, typed))[0].text).toContain("added manually");

    const old = await lead(null, now, { createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    expect(await notes(manager, old)).toHaveLength(0);
  });
});

describe("not opened yet alert", () => {
  it("fires once after 30 minutes, to the owner and the managers", async () => {
    const inq = await lead(agentA.id, at(0));
    expect((await alerts(29)).unopened).toBe(0);
    expect((await alerts(31)).unopened).toBe(1);
    const own = (await notes(agentA, inq)).filter((x) => x.kind === "lead_not_opened");
    expect(own).toHaveLength(1);
    expect(own[0].text).toMatch(/^Not opened yet: Notify \d+ was assigned to you 30 minutes ago\.$/);
    expect(own[0].popup).toBe(true);
    const mgr = (await notes(manager, inq)).filter((x) => x.kind === "lead_not_opened_manager");
    expect(mgr).toHaveLength(1);
    expect(mgr[0].text).toContain("(Notify Agent A)");
    expect((await alerts(60)).unopened).toBe(0); // no repeats
  });

  it("not for leads that were opened or closed, or assigned more than a day ago", async () => {
    const opened = await lead(agentA.id, at(0));
    await as(agentA, (q) => q("select public.mark_inquiry_opened($1)", [opened]));
    const closed = await lead(agentA.id, at(0));
    await admin("update public.inquiries set stage_id = (select id from public.stages where system_key = 'lost') where id = $1", [closed]);
    const ancient = await lead(agentA.id, at(-2 * 24 * 60));
    await alerts(45);
    for (const i of [opened, closed, ancient]) expect((await notes(agentA, i)).filter((x) => x.kind === "lead_not_opened")).toHaveLength(0);
  });

  it("a new owner can be alerted again", async () => {
    const inq = await lead(agentA.id, at(0));
    await alerts(31);
    await admin("update public.inquiries set sales_owner_id = $2, assigned_at = $3 where id = $1", [inq, agentB.id, at(40)]);
    expect((await admin<{ t: Date | null }>("select unopened_alert_at as t from public.inquiries where id = $1", [inq]))[0].t).toBeNull();
    await alerts(71);
    expect((await notes(agentB, inq)).filter((x) => x.kind === "lead_not_opened")).toHaveLength(1);
  });

  it("can be switched off with 0 minutes", async () => {
    await as(manager, (q) => q("select public.update_settings($1)", [{ unopened_alert_minutes: 0 }]));
    try {
      const inq = await lead(agentA.id, at(0));
      expect((await alerts(120)).unopened).toBe(0);
      expect((await notes(agentA, inq)).filter((x) => x.kind === "lead_not_opened")).toHaveLength(0);
    } finally {
      await as(manager, (q) => q("select public.update_settings($1)", [{ unopened_alert_minutes: 30 }]));
    }
    await expectError(as(manager, (q) => q("select public.update_settings($1)", [{ unopened_alert_minutes: 5000 }])), "CRM01");
  });
});

describe("follow-up reminders", () => {
  async function followUp(inq: string, owner: string, dueMins: number, note = "Call back about the course"): Promise<string> {
    const [f] = await admin<{ id: string }>(
      "insert into public.follow_ups (inquiry_id, owner_id, due_at, note) values ($1, $2, $3, $4) returning id", [inq, owner, at(dueMins), note]);
    return f.id;
  }

  it("sent 15 minutes before the due time, once, with the Cairo time", async () => {
    const inq = await lead(agentA.id, at(0));
    await as(agentA, (q) => q("select public.mark_inquiry_opened($1)", [inq]));
    await followUp(inq, agentA.id, 60);
    await alerts(44);
    expect((await notes(agentA, inq)).filter((x) => x.kind === "followup_due")).toHaveLength(0);
    await alerts(46);
    const r = (await notes(agentA, inq)).filter((x) => x.kind === "followup_due");
    expect(r).toHaveLength(1);
    expect(r[0].text).toMatch(/^Follow-up due at 11:00 AM: Notify \d+ · Call back about the course$/);
    await alerts(50);
    expect((await notes(agentA, inq)).filter((x) => x.kind === "followup_due")).toHaveLength(1);
  });

  it("moving a follow-up gives a new reminder; done or long-overdue ones get none", async () => {
    const inq = await lead(agentA.id, at(0));
    await as(agentA, (q) => q("select public.mark_inquiry_opened($1)", [inq]));
    const f = await followUp(inq, agentA.id, 20, "Moved one");
    await alerts(10);
    await admin("update public.follow_ups set due_at = $2 where id = $1", [f, at(90)]);
    await alerts(80);
    expect((await notes(agentA, inq)).filter((x) => x.text.includes("Moved one"))).toHaveLength(2);

    const done = await followUp(inq, agentA.id, 100, "Done one");
    await admin("update public.follow_ups set status = 'done', completed_at = now() where id = $1", [done]);
    await followUp(inq, agentA.id, -200, "Ancient one");
    await alerts(95);
    expect((await notes(agentA, inq)).filter((x) => x.text.includes("Done one") || x.text.includes("Ancient one"))).toHaveLength(0);
  });

  it("support follow-ups are reminded too", async () => {
    const support = await createUser("support", "Notify Support Reminder");
    const inq = await lead(agentA.id, at(0));
    const [{ id: course }] = await admin<{ id: string }>(
      "insert into public.courses (program_id, name, price, currency) values ($1, 'Notify course', 1000, 'EGP') returning id", [program]);
    const [{ id: enr }] = await admin<{ id: string }>(
      "insert into public.enrollments (inquiry_id, course_id, agreed_total, currency, original_sales_owner_id, created_by) values ($1, $2, 1000, 'EGP', $3, $3) returning id", [inq, course, agentA.id]);
    const [{ id: ob }] = await admin<{ id: string }>("insert into public.onboardings (enrollment_id, support_owner_id) values ($1, $2) returning id", [enr, support.id]);
    await admin("insert into public.support_follow_ups (onboarding_id, owner_id, due_at, note) values ($1, $2, $3, 'Send the class link')", [ob, support.id, at(30)]);
    await alerts(30);
    const r = (await notes(support, inq)).filter((x) => x.kind === "followup_due");
    expect(r).toHaveLength(1);
    expect(r[0].text).toMatch(/^Follow-up due now: Notify \d+ · Send the class link$/);
    await admin("update public.profiles set active = false where id = $1", [support.id]);
  });

  it("the scheduler function is not callable by staff", async () => {
    await expectError(as(manager, (q) => q("select private.send_timed_alerts(now())")), "42501");
  });
});
