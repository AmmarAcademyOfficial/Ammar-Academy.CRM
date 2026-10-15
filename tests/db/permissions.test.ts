/**
 * Who can see and change what. Each test signs in as a real staff role
 * against PostgreSQL with the production migrations and RLS policies.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createInquiry, createUser, expectError, inquiryVersion, outcomeId, type TestUser } from "./helpers";

let manager: TestUser, salesA: TestUser, salesB: TestUser, support: TestUser;
let leadA: string, leadB: string;

beforeAll(async () => {
  manager = await createUser("manager", "Perm Manager");
  salesA = await createUser("sales", "Agent A");
  salesB = await createUser("sales", "Agent B");
  support = await createUser("support", "Support S");
  leadA = (await createInquiry(salesA, { name: "Lead of A" })).inquiry_id;
  leadB = (await createInquiry(salesB, { name: "Lead of B" })).inquiry_id;
  await as(salesB, (q) => q("select public.add_note($1, 'B private note')", [leadB]));
  await as(salesB, (q) => q("select public.create_follow_up($1, now() + interval '1 day', 'Call B lead')", [leadB]));
});
afterAll(closeDb);

describe("signed-out and direct access", () => {
  it("anonymous requests cannot read any business table", async () => {
    await expectError(as(null, (q) => q("select * from public.inquiries")), "42501");
    await expectError(as(null, (q) => q("select * from public.contacts")), "42501");
    await expectError(as(null, (q) => q("select public.add_note($1, 'x')", [leadA])), "42501");
  });

  it("staff cannot insert, update or delete business rows directly", async () => {
    await expectError(as(salesA, (q) => q("update public.inquiries set sales_owner_id = $1 where id = $2", [salesA.id, leadB])), "42501");
    await expectError(as(manager, (q) => q("delete from public.activities")), "42501");
    await expectError(as(salesA, (q) => q("insert into public.contacts (name, phone, phone_normalized) values ('x','1','+201000000000')")), "42501");
    await expectError(as(manager, (q) => q("update public.profiles set role = 'manager' where id = $1", [salesA.id])), "42501");
  });
});

describe("sales agents see only their own records", () => {
  it("lists, counts and lookups by id exclude other agents' inquiries", async () => {
    const rows = await as(salesA, (q) => q<{ id: string }>("select id from public.inquiries"));
    expect(rows.map((r) => r.id)).toContain(leadA);
    expect(rows.map((r) => r.id)).not.toContain(leadB);
    const [{ n }] = await as(salesA, (q) => q<{ n: string }>("select count(*) as n from public.inquiries where sales_owner_id = $1", [salesB.id]));
    expect(Number(n)).toBe(0);
    expect(await as(salesA, (q) => q("select * from public.inquiries where id = $1", [leadB]))).toHaveLength(0);
  });

  it("search over contacts never returns another agent's customer", async () => {
    const hits = await as(salesA, (q) => q("select * from public.contacts where name ilike '%Lead of B%'"));
    expect(hits).toHaveLength(0);
  });

  it("notes, follow-ups and tags of another agent's lead are hidden", async () => {
    expect(await as(salesA, (q) => q("select * from public.activities where inquiry_id = $1", [leadB]))).toHaveLength(0);
    expect(await as(salesA, (q) => q("select * from public.follow_ups where inquiry_id = $1", [leadB]))).toHaveLength(0);
  });

  it("direct function calls on another agent's lead are refused", async () => {
    await expectError(as(salesA, (q) => q("select public.add_note($1, 'sneaky')", [leadB])), "CRM04");
    await expectError(as(salesA, (q) => q("select public.change_stage($1, 'lost', null, 'x')", [leadB])), "CRM04");
    await expectError(as(salesA, async (q) => q("select public.record_contact_attempt($1, $2)", [leadB, await outcomeId("reached")])), "CRM04");
  });

  it("only managers reassign", async () => {
    await expectError(as(salesA, (q) => q("select public.reassign_inquiry($1, $2, 'mine now')", [leadB, salesA.id])), "CRM03");
  });
});

describe("support and managers", () => {
  it("support staff cannot see the sales prospect database (only customers handed over to support)", async () => {
    const notHandedOver = await as(support, (q) => q(`
      select i.id from public.inquiries i
      where not exists (select 1 from public.enrollments e join public.onboardings o on o.enrollment_id = e.id where e.inquiry_id = i.id)`));
    expect(notHandedOver).toHaveLength(0);
    expect(await as(support, (q) => q("select * from public.inquiries where id = any($1)", [[leadA, leadB]]))).toHaveLength(0);
    expect(await as(support, (q) => q(`
      select c.id from public.contacts c where not exists (
        select 1 from public.inquiries i join public.enrollments e on e.inquiry_id = i.id join public.onboardings o on o.enrollment_id = e.id
        where i.contact_id = c.id)`))).toHaveLength(0);
    await expectError(as(support, (q) => q("select public.add_note($1, 'x')", [leadA])), "CRM03");
  });

  it("managers see every inquiry and its notes", async () => {
    const ids = (await as(manager, (q) => q<{ id: string }>("select id from public.inquiries"))).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([leadA, leadB]));
    const notes = await as(manager, (q) => q("select * from public.activities where inquiry_id = $1 and type = 'comment'", [leadB]));
    expect(notes.length).toBeGreaterThan(0);
  });

  it("reassignment moves open follow-ups, notifies the new owner and is audited", async () => {
    const lead = (await createInquiry(salesB, { name: "To move" })).inquiry_id;
    await as(salesB, (q) => q("select public.create_follow_up($1, now() + interval '2 hours', 'Call')", [lead]));
    await as(manager, (q) => q("select public.reassign_inquiry($1, $2, 'Agent B on leave')", [lead, salesA.id]));
    const fu = await admin<{ owner_id: string }>("select owner_id from public.follow_ups where inquiry_id = $1 and status = 'open'", [lead]);
    expect(fu.every((f) => f.owner_id === salesA.id)).toBe(true);
    expect(await as(salesA, (q) => q("select * from public.inquiries where id = $1", [lead]))).toHaveLength(1);
    expect(await as(salesB, (q) => q("select * from public.inquiries where id = $1", [lead]))).toHaveLength(0);
    expect(await as(salesA, (q) => q("select * from public.notifications where inquiry_id = $1", [lead]))).toHaveLength(1);
    const audit = await as(manager, (q) => q<{ action: string }>("select action from public.audit_log where target = 'To move'"));
    expect(audit[0].action).toContain("Agent B on leave");
  });

  it("audit history is for managers only", async () => {
    expect(await as(salesA, (q) => q("select * from public.audit_log"))).toHaveLength(0);
  });
});

describe("custom field permissions", () => {
  let secretField: string;
  beforeAll(async () => {
    secretField = await as(manager, async (q) =>
      (await q<{ id: string }>("select public.save_field_definition($1) as id", [{ label: "Manager note", type: "text", importance: "additional", required_from: "never", program_ids: [], visible_to: ["manager"], editable_by: ["manager"], options: [] }]))[0].id,
    );
    await as(manager, (q) => q("select public.set_field_values($1, $2, null)", [leadA, { [secretField]: "VIP discount" }]));
  });

  it("a field hidden from sales never reaches sales, even on their own lead", async () => {
    const rows = await as(salesA, (q) => q("select * from public.field_values where inquiry_id = $1 and field_id = $2", [leadA, secretField]));
    expect(rows).toHaveLength(0);
    const all = await as(manager, (q) => q("select * from public.field_values where inquiry_id = $1 and field_id = $2", [leadA, secretField]));
    expect(all).toHaveLength(1);
  });

  it("sales cannot write a field they may not edit", async () => {
    await expectError(as(salesA, (q) => q("select public.set_field_values($1, $2, null)", [leadA, { [secretField]: "x" }])), "CRM03");
  });

  it("managers must always see a field; editors must see it", async () => {
    await expectError(
      as(manager, (q) => q("select public.save_field_definition($1)", [{ id: secretField, label: "Manager note", type: "text", visible_to: ["sales"], editable_by: ["sales"], options: [] }])),
      "CRM01",
    );
  });
});

describe("staff accounts", () => {
  it("the last active manager cannot be deactivated or demoted", async () => {
    // Deactivate every other manager created by other tests so this one is the last.
    const solo = await createUser("manager", "Solo Manager");
    await admin("update public.profiles set active = false where role = 'manager' and id <> $1", [solo.id]);
    await expectError(as(solo, (q) => q("select public.set_user_active($1, false)", [solo.id])), "CRM01", "last active manager");
    await expectError(as(solo, (q) => q("select public.set_user_role($1, 'sales')", [solo.id])), "CRM01", "last active manager");
    // With a second manager it works.
    const second = await createUser("manager", "Second Manager");
    await as(solo, (q) => q("select public.set_user_active($1, false)", [second.id]));
    await as(solo, (q) => q("select public.set_user_active($1, true)", [second.id]));
    await admin("update public.profiles set active = true where role = 'manager'");
  });

  it("a deactivated user sees nothing and cannot act, but their history remains", async () => {
    const leaver = await createUser("sales", "Leaver");
    const lead = (await createInquiry(leaver, { name: "Leaver lead" })).inquiry_id;
    await as(leaver, (q) => q("select public.add_note($1, 'my note')", [lead]));
    await as(manager, (q) => q("select public.set_user_active($1, false)", [leaver.id]));
    expect(await as(leaver, (q) => q("select * from public.inquiries"))).toHaveLength(0);
    await expectError(as(leaver, (q) => q("select public.add_note($1, 'again')", [lead])), "CRM03");
    const notes = await as(manager, (q) => q<{ actor_id: string }>("select actor_id from public.activities where inquiry_id = $1 and type = 'comment'", [lead]));
    expect(notes[0].actor_id).toBe(leaver.id);
  });

  it("sales agents may pause only themselves", async () => {
    await as(salesA, (q) => q("select public.set_user_paused($1, true)", [salesA.id]));
    await expectError(as(salesA, (q) => q("select public.set_user_paused($1, true)", [salesB.id])), "CRM03");
    await as(salesA, (q) => q("select public.set_user_paused($1, false)", [salesA.id]));
  });
});

describe("personal data", () => {
  it("saved views and notifications are private to their owner", async () => {
    await as(salesA, (q) => q("insert into public.saved_views (user_id, name, filters) values ($1, 'Mine', '{}')", [salesA.id]));
    await expectError(as(salesA, (q) => q("insert into public.saved_views (user_id, name, filters) values ($1, 'Theirs', '{}')", [salesB.id])), "42501");
    expect(await as(salesB, (q) => q("select * from public.saved_views where name = 'Mine'"))).toHaveLength(0);
    await expectError(as(salesA, (q) => q("update public.notifications set text = 'changed'")), "42501");
  });

  it("version numbers move forward with each change", async () => {
    const v = await inquiryVersion(leadA);
    await as(salesA, (q) => q("select public.set_tags($1, '{}', null)", [leadA]));
    expect(await inquiryVersion(leadA)).toBe(v + 1);
  });
});
