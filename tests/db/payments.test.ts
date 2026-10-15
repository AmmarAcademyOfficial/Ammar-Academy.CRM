/** Phase 4: courses catalog, enrollments, payments, handover, reversal and support onboarding. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createInquiry, createUser, expectError, type TestUser } from "./helpers";

let manager: TestUser, agent: TestUser, otherAgent: TestUser, support1: TestUser, support2: TestUser;
let prog: string, prog2: string, typeId: string, course: string, closedCourse: string, otherProgCourse: string;
const RECEIPT = { path: "receipts/11111111-2222-4333-8444-555555555555.jpg", name: "transfer.jpg", mime: "image/jpeg", size: 1234 };
let refN = 0;
const ref = () => `REF-${Date.now()}-${++refN}`;
const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10); // Cairo date (UTC+3 in October)

async function lead(user = agent, program = prog) {
  return (await createInquiry(user, { program_id: program })).inquiry_id;
}
async function enroll(inquiry: string, total = 10000, note: string | null = null, user = agent) {
  return as(user, async (q) => (await q<{ id: string }>("select public.save_enrollment($1) as id", [{ inquiry_id: inquiry, course_id: course, agreed_total: total, price_note: note }]))[0].id);
}
async function pay(enrollment: string, amount: number, extra: Record<string, unknown> = {}, user = agent) {
  return as(user, async (q) => (await q<{ id: string }>("select public.submit_payment($1) as id", [{
    enrollment_id: enrollment, amount, paid_on: today(), method: "instapay", reference: ref(), receipt: RECEIPT, ...extra,
  }]))[0].id);
}
async function decide(payment: string, decision: "confirmed" | "rejected", reason: string | null = null) {
  return as(manager, async (q) => (await q<{ r: { handed_over: boolean; paid: number; balance: number } }>("select public.decide_payment($1, $2, $3) as r", [payment, decision, reason]))[0].r);
}
const stageOf = async (inquiry: string) => (await admin<{ k: string }>("select s.system_key as k from public.inquiries i join public.stages s on s.id = i.stage_id where i.id = $1", [inquiry]))[0].k;
const onboardingOf = async (enrollment: string) => (await admin<{ id: string; flagged_reason: string | null; support_owner_id: string | null; status: string }>(
  "select id, flagged_reason, support_owner_id, status from public.onboardings where enrollment_id = $1", [enrollment]))[0];

beforeAll(async () => {
  manager = await createUser("manager", "Pay Manager");
  agent = await createUser("sales", "Pay Agent");
  otherAgent = await createUser("sales", "Pay Other Agent");
  support1 = await createUser("support", "Support One");
  support2 = await createUser("support", "Support Two");
  [{ id: prog }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('PAYA', 'Pay Program') returning id");
  [{ id: prog2 }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('PAYB', 'Other Program') returning id");
  // 30% qualifying deposit for the test program; deposit-based handover.
  await admin("update public.app_settings set handover_trigger = 'qualifying_deposit', deposit_rule = deposit_rule || jsonb_build_object($1::text, jsonb_build_object('kind', 'percent', 'value', 30))", [prog]);
  typeId = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course_type($1) as id", [{ name: "Test Group Type", color: "blue" }]))[0].id);
  const mk = (p: Record<string, unknown>) => as(manager, async (q) => (await q<{ id: string }>("select public.save_course($1) as id", [{ course_type_id: typeId, currency: "EGP", ...p }]))[0].id);
  course = await mk({ program_id: prog, name: "Pay Course", price: 10000, sessions_count: 12, delivery: "online" });
  closedCourse = await mk({ program_id: prog, name: "Closed Course", price: 5000, active: false });
  otherProgCourse = await mk({ program_id: prog2, name: "Other Program Course", price: 7000 });
});
afterAll(closeDb);

describe("courses catalog", () => {
  it("validates input and is manager-only", async () => {
    const base = { program_id: prog, course_type_id: typeId, name: "X" };
    await expectError(as(manager, (q) => q("select public.save_course($1)", [{ ...base, course_type_id: null }])), "CRM01", "course type");
    await expectError(as(manager, (q) => q("select public.save_course($1)", [{ ...base, price: -5 }])), "CRM01", "negative");
    await expectError(as(manager, (q) => q("select public.save_course($1)", [{ ...base, start_date: "2026-12-01", end_date: "2026-11-01" }])), "CRM01", "end date");
    await expectError(as(manager, (q) => q("select public.save_course_type($1)", [{ name: "test group type" }])), "CRM01", "already exists");
    await expectError(as(agent, (q) => q("select public.save_course($1)", [base])), "CRM03");
    await expectError(as(agent, (q) => q("select public.save_course_type($1)", [{ name: "Agent Type" }])), "CRM03");
    const seen = await as(support1, (q) => q<{ name: string }>("select name from public.courses where id = $1", [course]));
    expect(seen).toEqual([{ name: "Pay Course" }]); // every staff member can read the catalog
  });

  it("price changes are kept in the audit history", async () => {
    await as(manager, (q) => q("select public.save_course($1)", [{ id: closedCourse, program_id: prog, course_type_id: typeId, name: "Closed Course", price: 5500, active: false }]));
    const a = await admin<{ action: string }>("select action from public.audit_log where target = 'Closed Course' order by created_at desc limit 1");
    expect(a[0].action).toBe("Updated course · price 5000.00 → 5500 EGP");
  });

  it("a lead is linked to a course of its own program", async () => {
    const i = await lead();
    await as(agent, (q) => q("select public.set_inquiry_course($1, $2)", [i, course]));
    expect((await admin<{ course_id: string }>("select course_id from public.inquiries where id = $1", [i]))[0].course_id).toBe(course);
    await expectError(as(agent, (q) => q("select public.set_inquiry_course($1, $2)", [i, otherProgCourse])), "CRM01", "another program");
    await expectError(as(agent, (q) => q("select public.set_inquiry_course($1, $2)", [i, closedCourse])), "CRM01", "closed");
    await expectError(as(otherAgent, (q) => q("select public.set_inquiry_course($1, null)", [i])), "CRM04");
    const [act] = await admin<{ body: string }>("select body from public.activities where inquiry_id = $1 and type = 'field_change'", [i]);
    expect(act.body).toBe("Course: Pay Course");
  });
});

describe("enrollments and payments", () => {
  it("a price different from the course price needs a reason", async () => {
    const i = await lead();
    await expectError(enroll(i, 9000), "CRM01", "differs from the course price");
    await enroll(i, 9000, "Sibling discount");
    expect(await stageOf(i)).toBe("awaiting_payment");
    expect((await admin<{ course_id: string }>("select course_id from public.inquiries where id = $1", [i]))[0].course_id).toBe(course);
  });

  it("checks each payment before it reaches a manager", async () => {
    const e = await enroll(await lead());
    await expectError(pay(e, 1000, { receipt: null }), "CRM01", "Attach the receipt");
    await expectError(pay(e, 1000, { reference: "" }), "CRM01", "reference");
    await expectError(pay(e, 1000, { paid_on: "2099-01-01" }), "CRM01", "future");
    await expectError(pay(e, 0), "CRM01", "amount");
    await expectError(pay(e, 1000, { method: "bitcoin" }), "CRM01", "how the customer paid");
    await pay(e, 1000, { method: "cash", reference: "", receipt: null }); // cash needs neither
    await pay(e, 8000);
    await expectError(pay(e, 1500), "CRM01", "remaining balance"); // 10,000 − 9,000 pending
    const r = ref();
    await pay(e, 500, { reference: r });
    await expectError(pay(e, 500, { reference: r }), "CRM01", "already submitted");
    await expectError(pay(e, 100, {}, otherAgent), "CRM04");
  });

  it("only confirmed payments count, and only managers decide", async () => {
    const i = await lead();
    const e = await enroll(i);
    const p1 = await pay(e, 2000);
    const notes = await admin("select 1 from public.notifications where user_id = $1 and text like 'Payment to review%'", [manager.id]);
    expect(notes.length).toBeGreaterThan(0);
    await expectError(as(agent, (q) => q("select public.decide_payment($1, 'confirmed')", [p1])), "CRM03");
    await expectError(decide(p1, "rejected"), "CRM01", "reason");
    const r = await decide(p1, "rejected", "Reference not found");
    expect(r).toMatchObject({ handed_over: false, paid: 0 });
    await expectError(decide(p1, "confirmed"), "CRM01", "already rejected");
    const p2 = await pay(e, 2000);
    expect(await decide(p2, "confirmed")).toMatchObject({ handed_over: false, paid: 2000, balance: 8000 }); // 20% < 30%
    expect(await onboardingOf(e)).toBeUndefined();
  });

  it("meeting the qualifying deposit hands over exactly once: Enrolled, checklist, support told", async () => {
    const i = await lead();
    const e = await enroll(i);
    const p = await pay(e, 3000);
    expect((await decide(p, "confirmed")).handed_over).toBe(true);
    expect(await stageOf(i)).toBe("enrolled");
    const o = await onboardingOf(e);
    expect(o).toMatchObject({ status: "new_customer", support_owner_id: null });
    const items = await admin<{ label: string; due_at: Date }>("select label, due_at from public.onboarding_items where onboarding_id = $1 order by sort", [o.id]);
    const template = await admin("select 1 from public.checklist_template where not archived");
    expect(items).toHaveLength(template.length);
    expect(items[0].due_at).not.toBeNull();
    const told = await admin("select 1 from public.notifications where user_id = $1 and inquiry_id = $2 and text like 'New customer ready%'", [support1.id, i]);
    expect(told).toHaveLength(1);
    // A second confirmation never creates a second onboarding.
    expect((await decide(await pay(e, 1000), "confirmed")).handed_over).toBe(false);
    expect(await admin("select 1 from public.onboardings where enrollment_id = $1", [e])).toHaveLength(1);
    // Enrolled still cannot be chosen by hand.
    const j = await lead();
    await expectError(as(agent, (q) => q("select public.change_stage($1, 'enrolled', null)", [j])), "CRM01");
  });

  it("two confirmations at the same moment still give one onboarding", async () => {
    const e = await enroll(await lead());
    const a = await pay(e, 3000);
    const b = await pay(e, 3000);
    await Promise.all([decide(a, "confirmed"), decide(b, "confirmed")]);
    expect(await admin("select 1 from public.onboardings where enrollment_id = $1", [e])).toHaveLength(1);
  });

  it("with 'full payment' as the rule, a deposit does not hand over", async () => {
    await admin("update public.app_settings set handover_trigger = 'full_payment'");
    try {
      const e = await enroll(await lead());
      expect((await decide(await pay(e, 9000), "confirmed")).handed_over).toBe(false);
      expect((await decide(await pay(e, 1000), "confirmed")).handed_over).toBe(true);
    } finally {
      await admin("update public.app_settings set handover_trigger = 'qualifying_deposit'");
    }
  });

  it("without a deposit rule for the program, only full payment hands over", async () => {
    const [{ id: p3 }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('PAYC', 'No Rule') returning id");
    const c3 = await as(manager, async (q) => (await q<{ id: string }>("select public.save_course($1) as id", [{ program_id: p3, course_type_id: typeId, name: "No Rule Course", price: 4000 }]))[0].id);
    const i = await lead(agent, p3);
    const e = await as(agent, async (q) => (await q<{ id: string }>("select public.save_enrollment($1) as id", [{ inquiry_id: i, course_id: c3, agreed_total: 4000 }]))[0].id);
    expect((await decide(await pay(e, 3900), "confirmed")).handed_over).toBe(false);
    expect((await decide(await pay(e, 100), "confirmed")).handed_over).toBe(true);
  });

  it("after confirmed payments only a manager changes the agreed total, never below what is paid", async () => {
    const i = await lead();
    const e = await enroll(i);
    await decide(await pay(e, 2000), "confirmed");
    await expectError(enroll(i, 12000, "Upgrade"), "CRM01", "Ask a manager");
    await expectError(enroll(i, 1500, "Error", manager), "CRM01", "less than what is already confirmed");
    await enroll(i, 12000, "Upgraded to hybrid", manager);
    expect((await admin<{ agreed_total: string }>("select agreed_total from public.enrollments where id = $1", [e]))[0].agreed_total).toBe("12000.00");
  });
});

describe("reversals", () => {
  it("reversing below the rule keeps the onboarding and flags it; a new confirmation clears it", async () => {
    const i = await lead();
    const e = await enroll(i);
    const p = await pay(e, 3000);
    await decide(p, "confirmed");
    await expectError(as(manager, (q) => q("select public.reverse_payment($1, '')", [p])), "CRM01", "reason");
    const r = (await as(manager, (q) => q<{ r: { flagged: boolean; paid: number } }>("select public.reverse_payment($1, 'Bank returned the transfer') as r", [p])))[0].r;
    expect(r).toMatchObject({ flagged: true, paid: 0 });
    const o = await onboardingOf(e);
    expect(o.flagged_reason).toMatch(/reversed .*Bank returned the transfer/);
    await expectError(as(manager, (q) => q("select public.reverse_payment($1, 'again')", [p])), "CRM01", "Only confirmed");
    // The flagged customer cannot be marked Active.
    await as(manager, (q) => q("select public.assign_onboarding($1, $2)", [o.id, support1.id]));
    await admin("update public.onboarding_items set done_at = now() where onboarding_id = $1", [o.id]);
    await expectError(as(support1, (q) => q("select public.set_onboarding_status($1, 'active')", [o.id])), "CRM01", "flagged");
    await decide(await pay(e, 3000), "confirmed");
    expect((await onboardingOf(e)).flagged_reason).toBeNull();
    await as(support1, (q) => q("select public.set_onboarding_status($1, 'active')", [o.id]));
  });
});

describe("support onboarding", () => {
  let enrollmentId: string, onboardingId: string, inquiryId: string;
  beforeAll(async () => {
    inquiryId = await lead();
    enrollmentId = await enroll(inquiryId);
    await decide(await pay(enrollmentId, 5000), "confirmed");
    onboardingId = (await onboardingOf(enrollmentId)).id;
  });

  it("support sees handed-over customers in the queue, nothing else", async () => {
    const seen = await as(support1, (q) => q<{ id: string }>("select id from public.inquiries where id = $1", [inquiryId]));
    expect(seen).toHaveLength(1);
    const pays = await as(support1, (q) => q("select 1 from public.payments where enrollment_id = $1", [enrollmentId]));
    expect(pays.length).toBeGreaterThan(0); // read-only sales and payment history
    const notHanded = await lead();
    expect(await as(support1, (q) => q("select 1 from public.inquiries where id = $1", [notHanded]))).toHaveLength(0);
    // Support cannot do sales work on the customer.
    await expectError(as(support1, (q) => q("select public.add_note($1, 'hi')", [inquiryId])), "CRM03");
    await expectError(as(support1, (q) => q("select public.change_stage($1, 'lost', null, 'x')", [inquiryId])), "CRM03");
  });

  it("Assign to Me: two people at once, exactly one wins", async () => {
    const results = await Promise.allSettled([
      as(support1, (q) => q("select public.claim_onboarding($1)", [onboardingId])),
      as(support2, (q) => q("select public.claim_onboarding($1)", [onboardingId])),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason.message).toMatch(/Already assigned to Support (One|Two)/);
    const o = await onboardingOf(enrollmentId);
    expect(o.status).toBe("onboarding");
    const winner = o.support_owner_id === support1.id ? support1 : support2;
    const loser = winner === support1 ? support2 : support1;
    // The other support member no longer sees this customer.
    expect(await as(loser, (q) => q("select 1 from public.inquiries where id = $1", [inquiryId]))).toHaveLength(0);
    await expectError(as(agent, (q) => q("select public.claim_onboarding($1)", [onboardingId])), "CRM03");

    // Checklist, status and follow-ups belong to the owner.
    const [item] = await admin<{ template_item_id: string }>("select template_item_id from public.onboarding_items where onboarding_id = $1 order by sort limit 1", [onboardingId]);
    await expectError(as(loser, (q) => q("select public.set_checklist_item($1, $2, true)", [onboardingId, item.template_item_id])), "CRM03");
    await as(winner, (q) => q("select public.set_checklist_item($1, $2, true)", [onboardingId, item.template_item_id]));
    const err = await expectError(as(winner, (q) => q("select public.set_onboarding_status($1, 'active')", [onboardingId])), "CRM01", "Finish the onboarding checklist");
    expect(JSON.parse((err as unknown as { detail: string }).detail).length).toBeGreaterThan(0);
    await admin("update public.onboarding_items set done_at = now() where onboarding_id = $1", [onboardingId]);
    await as(winner, (q) => q("select public.set_onboarding_status($1, 'active')", [onboardingId]));

    const [{ id: fu }] = await as(winner, (q) => q<{ id: string }>("select public.create_support_follow_up($1, now() + interval '7 days', 'Check first-week progress') as id", [onboardingId]));
    await expectError(as(agent, (q) => q("select public.create_support_follow_up($1, now() + interval '1 day', 'x')", [onboardingId])), "CRM03");
    // Support follow-ups never appear in sales follow-ups.
    expect(await admin("select 1 from public.follow_ups where note = 'Check first-week progress'")).toHaveLength(0);
    await as(winner, (q) => q("select public.complete_support_follow_up($1)", [fu]));
    await as(winner, (q) => q("select public.add_support_note($1, 'Joined the WhatsApp group')", [onboardingId]));
    const note = await as(agent, (q) => q<{ body: string }>("select body from public.activities where inquiry_id = $1 and type = 'comment' order by created_at desc limit 1", [inquiryId]));
    expect(note[0].body).toBe("Joined the WhatsApp group"); // the sales owner sees support's notes

    // Manager reassignment needs a reason and moves open follow-ups.
    await expectError(as(manager, (q) => q("select public.assign_onboarding($1, $2)", [onboardingId, loser.id])), "CRM01", "reason");
    await as(manager, (q) => q("select public.assign_onboarding($1, $2, 'Covering leave')", [onboardingId, loser.id]));
    expect(await as(loser, (q) => q("select 1 from public.inquiries where id = $1", [inquiryId]))).toHaveLength(1);
    await expectError(as(manager, (q) => q("select public.assign_onboarding($1, $2, 'x')", [onboardingId, agent.id])), "CRM01", "support team member");
  });

  it("checklist template is manager-managed and only affects new handovers", async () => {
    const [{ id }] = await as(manager, (q) => q<{ id: string }>("select public.save_checklist_item($1) as id", [{ label: "Send welcome pack", due_after_days: 3 }]));
    await expectError(as(support1, (q) => q("select public.save_checklist_item($1)", [{ label: "x" }])), "CRM03");
    const before = await admin("select 1 from public.onboarding_items where onboarding_id = $1 and template_item_id = $2", [onboardingId, id]);
    expect(before).toHaveLength(0);
    const e = await enroll(await lead());
    await decide(await pay(e, 3000), "confirmed");
    const o = await onboardingOf(e);
    expect(await admin("select 1 from public.onboarding_items where onboarding_id = $1 and template_item_id = $2", [o.id, id])).toHaveLength(1);
    await as(manager, (q) => q("select public.set_checklist_item_archived($1, true)", [id]));
  });
});
