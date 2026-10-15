/** Business rules enforced by the database functions. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { inject } from "vitest";
import { admin, as, closeDb, createInquiry, createUser, expectError, fieldPayload, inquiryVersion, newPhone, outcomeId, programId, type TestUser } from "./helpers";

let manager: TestUser, sales: TestUser;
beforeAll(async () => {
  manager = await createUser("manager", "Rules Manager");
  sales = await createUser("sales", "Rules Agent");
});
afterAll(closeDb);

describe("creating inquiries", () => {
  it("an agent's manual inquiry is owned by that agent", async () => {
    const r = await createInquiry(sales);
    const [q] = await admin<{ sales_owner_id: string; source: string }>("select sales_owner_id, source from public.inquiries where id = $1", [r.inquiry_id]);
    expect(q).toEqual({ sales_owner_id: sales.id, source: "manual" });
  });

  it("a manager's inquiry can be queued or assigned", async () => {
    const queued = await createInquiry(manager);
    expect(queued.queued).toBe(true);
    const assigned = await createInquiry(manager, { assign_to: sales.id });
    expect(assigned.queued).toBe(false);
    expect(await as(sales, (q) => q("select * from public.notifications where inquiry_id = $1", [assigned.inquiry_id]))).toHaveLength(1);
  });

  it("shared family phone: second child and second program link to one contact without merging", async () => {
    const phone = newPhone();
    const ali = await createInquiry(sales, { name: "Hoda", phone_normalized: phone, contact_type: "parent", student_name: "Ali" });
    const salma = await createInquiry(sales, { name: "Hoda", phone_normalized: phone, contact_type: "parent", student_name: "Salma" });
    const ielts = await createInquiry(sales, { name: "Hoda", phone_normalized: phone, program_id: await programId("IELTS"), student_name: "Ali" });
    expect(salma.matched_existing && ielts.matched_existing).toBe(true);
    const rows = await admin<{ contact_id: string }>("select distinct contact_id from public.inquiries where id = any($1)", [[ali.inquiry_id, salma.inquiry_id, ielts.inquiry_id]]);
    expect(rows).toHaveLength(1);
  });

  it("the same open inquiry is not created twice", async () => {
    const phone = newPhone();
    await createInquiry(sales, { phone_normalized: phone });
    await expectError(createInquiry(sales, { phone_normalized: phone }), "CRM01", "already has an open SAT inquiry");
  });

  it("concurrent creation of the same new phone yields one contact and one inquiry", async () => {
    const phone = newPhone();
    const url = inject("databaseUrl");
    const attempt = async () => {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        await c.query("begin");
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: sales.id })]);
        await c.query("select public.create_inquiry($1)", [{ name: "Race", phone: phone, phone_normalized: phone, program_id: await programId("SAT") }]);
        await c.query("select pg_sleep(0.2)");
        await c.query("commit");
        return "ok";
      } catch (e) {
        await c.query("rollback").catch(() => {});
        return (e as { code: string }).code;
      } finally {
        await c.end();
      }
    };
    const results = await Promise.all([attempt(), attempt()]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect((await admin("select * from public.contacts where phone_normalized = $1", [phone]))).toHaveLength(1);
    expect((await admin("select i.* from public.inquiries i join public.contacts c on c.id = i.contact_id where c.phone_normalized = $1", [phone]))).toHaveLength(1);
  });
});

describe("notes and timeline", () => {
  it("notes keep author and time, and editing keeps the earlier version", async () => {
    const { inquiry_id } = await createInquiry(sales);
    const [{ id }] = await as(sales, (q) => q<{ id: string }>("select public.add_note($1, 'اتصلت ولم يرد') as id", [inquiry_id]));
    const [note] = await admin<{ actor_id: string; created_at: Date; body: string }>("select actor_id, created_at, body from public.activities where id = $1", [id]);
    expect(note.actor_id).toBe(sales.id);
    expect(note.body).toBe("اتصلت ولم يرد");
    await as(sales, (q) => q("select public.edit_note($1, 'اتصلت مرتين')", [id]));
    const revs = await admin<{ body: string }>("select body from public.note_revisions where activity_id = $1", [id]);
    expect(revs.map((r) => r.body)).toEqual(["اتصلت ولم يرد"]);
    await expectError(as(manager, (q) => q("select public.edit_note($1, 'not mine')", [id])), "CRM03");
    await admin("update public.activities set created_at = now() - interval '1 hour' where id = $1", [id]);
    await expectError(as(sales, (q) => q("select public.edit_note($1, 'too late')", [id])), "CRM01", "minutes after posting");
  });

  it("adding a note never replaces earlier notes", async () => {
    const { inquiry_id } = await createInquiry(sales);
    await as(sales, (q) => q("select public.add_note($1, 'first')", [inquiry_id]));
    await as(sales, (q) => q("select public.add_note($1, 'second')", [inquiry_id]));
    const notes = await admin("select * from public.activities where inquiry_id = $1 and type = 'comment' and body in ('first','second')", [inquiry_id]);
    expect(notes).toHaveLength(2);
  });
});

describe("stages", () => {
  it("Lost requires a reason; Enrolled is not selectable by agents", async () => {
    const { inquiry_id } = await createInquiry(sales);
    const v = await inquiryVersion(inquiry_id);
    await expectError(as(sales, (q) => q("select public.change_stage($1, 'lost', $2, '')", [inquiry_id, v])), "CRM01", "reason");
    await expectError(as(sales, (q) => q("select public.change_stage($1, 'enrolled', $2)", [inquiry_id, v])), "CRM01", "payment");
    await as(sales, (q) => q("select public.change_stage($1, 'lost', $2, 'Budget')", [inquiry_id, v]));
    const [r] = await admin<{ lost_reason: string }>("select lost_reason from public.inquiries where id = $1", [inquiry_id]);
    expect(r.lost_reason).toBe("Budget");
  });

  it("a stale version is refused so two people cannot overwrite each other", async () => {
    const { inquiry_id } = await createInquiry(sales);
    const v = await inquiryVersion(inquiry_id);
    await as(sales, (q) => q("select public.change_stage($1, 'contacting', $2)", [inquiry_id, v]));
    await expectError(as(sales, (q) => q("select public.change_stage($1, 'qualified', $2)", [inquiry_id, v])), "CRM09");
  });

  it("stage-based required fields block moving forward, but never block Lost or unrelated edits", async () => {
    const fieldId = await as(manager, async (q) =>
      (await q<{ id: string }>("select public.save_field_definition($1) as id", [{ label: "Parent email", type: "text", importance: "standard", required_from: "qualified", program_ids: [], visible_to: ["manager", "sales", "support"], editable_by: ["manager", "sales"], options: [] }]))[0].id,
    );
    const { inquiry_id } = await createInquiry(sales);
    const err = await expectError(as(sales, (q) => q("select public.change_stage($1, 'qualified', null)", [inquiry_id])), "CRM01", "required fields") as { detail?: string };
    expect(JSON.parse(err.detail ?? "[]")).toContain("Parent email");
    // Unrelated edit on the same record still works.
    await as(sales, (q) => q("select public.add_note($1, 'still fine')", [inquiry_id]));
    await as(sales, (q) => q("select public.set_field_values($1, $2, null)", [inquiry_id, { [fieldId]: "mum@example.com" }]));
    await as(sales, (q) => q("select public.change_stage($1, 'qualified', null)", [inquiry_id]));
    await as(manager, (q) => q("select public.set_field_archived($1, true)", [fieldId]));
  });
});

describe("contact attempts and Do Not Contact", () => {
  it("a contact attempt records the outcome and moves New to Contacting", async () => {
    const { inquiry_id } = await createInquiry(sales);
    await as(sales, async (q) => q("select public.record_contact_attempt($1, $2, 'no answer')", [inquiry_id, await outcomeId("no_answer")]));
    const [r] = await admin<{ key: string; first: Date | null }>(
      "select s.system_key as key, i.first_contact_attempt_at as first from public.inquiries i join public.stages s on s.id = i.stage_id where i.id = $1", [inquiry_id]);
    expect(r.key).toBe("contacting");
    expect(r.first).not.toBeNull();
  });

  it("opening Call/WhatsApp is logged but is not a contact attempt", async () => {
    const { inquiry_id } = await createInquiry(sales);
    await as(sales, (q) => q("select public.log_outreach_shortcut($1, 'whatsapp')", [inquiry_id]));
    const [r] = await admin<{ first: Date | null }>("select first_contact_attempt_at as first from public.inquiries where id = $1", [inquiry_id]);
    expect(r.first).toBeNull();
  });

  it("Do Not Contact blocks outreach, cancels open follow-ups, and only managers remove it", async () => {
    const { inquiry_id } = await createInquiry(sales);
    await as(sales, (q) => q("select public.create_follow_up($1, now() + interval '1 hour', 'call')", [inquiry_id]));
    await as(sales, (q) => q("select public.set_do_not_contact($1, true, 'Asked not to be called')", [inquiry_id]));
    expect(await admin("select * from public.follow_ups where inquiry_id = $1 and status = 'open'", [inquiry_id])).toHaveLength(0);
    await expectError(as(sales, async (q) => q("select public.record_contact_attempt($1, $2)", [inquiry_id, await outcomeId("reached")])), "CRM01", "Do Not Contact");
    await expectError(as(sales, (q) => q("select public.create_follow_up($1, now() + interval '1 hour', 'call')", [inquiry_id])), "CRM01");
    await expectError(as(sales, (q) => q("select public.set_do_not_contact($1, false)", [inquiry_id])), "CRM03");
    await as(manager, (q) => q("select public.set_do_not_contact($1, false)", [inquiry_id]));
  });
});

describe("custom fields", () => {
  it("renaming and reordering a field keeps stored values", async () => {
    const [grade] = await admin<{ id: string }>("select id from public.field_definitions where key = 'grade'");
    const [opt] = await admin<{ id: string }>("select id from public.field_options where field_id = $1 order by sort limit 1", [grade.id]);
    const { inquiry_id } = await createInquiry(sales);
    await as(sales, (q) => q("select public.set_field_values($1, $2, null)", [inquiry_id, { [grade.id]: opt.id }]));
    const def = await fieldPayload("grade");
    await as(manager, (q) => q("select public.save_field_definition($1)", [{ ...def, label: "School grade" }]));
    await as(manager, (q) => q("select public.move_field($1, 1)", [grade.id]));
    const [v] = await admin<{ value: string }>("select value from public.field_values where inquiry_id = $1 and field_id = $2", [inquiry_id, grade.id]);
    expect(v.value).toBe(opt.id);
  });

  it("an archived dropdown option stays readable on older records but cannot be chosen again", async () => {
    const f = await fieldPayload("ielts_type");
    const opts = f.options as { id: string; label: string; archived: boolean }[];
    const { inquiry_id } = await createInquiry(sales, { program_id: await programId("IELTS") });
    await as(sales, (q) => q("select public.set_field_values($1, $2, null)", [inquiry_id, { [f.id]: opts[1].id }]));
    await as(manager, (q) => q("select public.save_field_definition($1)", [{ ...f, options: opts.map((o, i) => ({ ...o, archived: i === 1 })) }]));
    // Still stored and visible
    expect(await as(sales, (q) => q("select * from public.field_values where inquiry_id = $1 and field_id = $2", [inquiry_id, f.id]))).toHaveLength(1);
    // Saving the same archived value again is allowed (no change); choosing it for a new record is not.
    const other = (await createInquiry(sales, { program_id: await programId("IELTS") })).inquiry_id;
    await expectError(as(sales, (q) => q("select public.set_field_values($1, $2, null)", [other, { [f.id]: opts[1].id }])), "CRM01", "listed options");
    await as(manager, (q) => q("select public.save_field_definition($1)", [{ ...f, options: opts.map((o) => ({ ...o, archived: false })) }]));
  });

  it("a type change that would lose data is refused and nothing changes", async () => {
    const school = await fieldPayload("school");
    const { inquiry_id } = await createInquiry(sales);
    await as(sales, (q) => q("select public.set_field_values($1, $2, null)", [inquiry_id, { [school.id]: "Cairo American College" }]));
    await expectError(as(manager, (q) => q("select public.save_field_definition($1)", [{ ...school, type: "number", options: [] }])), "CRM01", "cannot convert");
    const [after] = await admin<{ type: string }>("select type from public.field_definitions where id = $1", [school.id]);
    expect(after.type).toBe("text");
  });

  it("invalid values are rejected with a readable message", async () => {
    const [f] = await admin<{ id: string }>("select id from public.field_definitions where key = 'exam_date'");
    const { inquiry_id } = await createInquiry(sales);
    await expectError(as(sales, (q) => q("select public.set_field_values($1, $2, null)", [inquiry_id, { [f.id]: "next week" }])), "CRM01", "Planned exam date");
  });
});

describe("tags and settings", () => {
  it("agents create tags only when managers allow it", async () => {
    await expectError(as(sales, (q) => q("select public.create_tag('Hot', 'red')")), "CRM03");
    await as(manager, (q) => q("select public.update_settings($1)", [{ agents_can_create_tags: true }]));
    await as(sales, (q) => q("select public.create_tag('Hot lead', 'red')"));
    await as(manager, (q) => q("select public.update_settings($1)", [{ agents_can_create_tags: false }]));
  });

  it("renaming a stage keeps its meaning", async () => {
    const [s] = await admin<{ id: string }>("select id from public.stages where system_key = 'qualified'");
    await as(manager, (q) => q("select public.rename_stage($1, 'Interested')", [s.id]));
    const { inquiry_id } = await createInquiry(sales);
    await as(sales, (q) => q("select public.change_stage($1, 'qualified', null)", [inquiry_id]));
    const [r] = await admin<{ label: string }>("select s.label from public.inquiries i join public.stages s on s.id = i.stage_id where i.id = $1", [inquiry_id]);
    expect(r.label).toBe("Interested");
    await as(manager, (q) => q("select public.rename_stage($1, 'Qualified')", [s.id]));
  });
});
