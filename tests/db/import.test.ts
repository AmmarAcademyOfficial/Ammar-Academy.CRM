/** Google Sheets import ledger, resubmissions, Needs Review and token protection (Phase 3). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createUser, expectError, newPhone, type TestUser } from "./helpers";

let manager: TestUser, agentA: TestUser;
let prog: string, prog2: string, account: string, conn: string;
let gradeField: string, grade11: string, examDate: string;

const row = (phone: string, extra: Record<string, unknown> = {}) => ({
  name: "Sheet Lead", phone, phone_normalized: phone, program_id: prog, contact_type: "student", ...extra,
});
const importRow = async (key: string, payload: Record<string, unknown>, rowNumber = 2, connection = conn) =>
  (await admin<{ r: { outcome: string; inquiry_id?: string } }>("select private.import_sheet_row($1, $2, $3, $4) as r", [connection, key, rowNumber, payload]))[0].r;

beforeAll(async () => {
  manager = await createUser("manager", "Import Manager");
  agentA = await createUser("sales", "Import Agent");
  [{ id: prog }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('IMPA', 'Import A') returning id");
  [{ id: prog2 }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('IMPB', 'Import B') returning id");
  // Agent A is on shift for both test programs all week.
  for (let d = 0; d < 7; d++) {
    await as(manager, (q) => q("select public.save_shift($1)", [{ user_id: agentA.id, weekday: d, start: "00:00", end: "00:00", program_ids: [prog, prog2] }]));
  }
  [{ id: account }] = await admin<{ id: string }>("select private.save_google_account('ammar.test@example.test', 'v1:ciphertext', 'drive.file', $1) as id", [manager.id]);
  // Own fields, so other test files that edit the starter fields cannot affect these tests.
  [{ id: gradeField }] = await admin<{ id: string }>("insert into public.field_definitions (key, label, type) values ('imp_grade', 'Import Grade', 'dropdown') returning id");
  [{ id: grade11 }] = await admin<{ id: string }>("insert into public.field_options (field_id, label) values ($1, 'Grade 11') returning id", [gradeField]);
  [{ id: examDate }] = await admin<{ id: string }>("insert into public.field_definitions (key, label, type) values ('imp_exam', 'Import Exam Date', 'date') returning id");
  conn = await as(manager, async (q) => (await q<{ id: string }>("select public.save_sheet_connection($1) as id", [{
    google_account_id: account, spreadsheet_id: "TESTsheet0000001", spreadsheet_name: "SAT Leads", sheet_title: "Form Responses 1",
    sheet_gid: 0, program_id: prog, headers: ["Timestamp", "Name", "Phone"],
    mapping: [{ column: 0, header: "Timestamp", target: "submitted_at" }, { column: 1, header: "Name", target: "name" }, { column: 2, header: "Phone", target: "phone" }],
    identity: "timestamp_phone", import_mode: "all",
  }]))[0].id);
});
afterAll(closeDb);

describe("importing rows", () => {
  it("imports, assigns by round-robin and keeps the submission time", async () => {
    const phone = newPhone();
    const r = await importRow("k-basic", row(phone, { submitted_at: "2026-10-01T09:15:00+03:00", custom: { [gradeField]: grade11 } }));
    expect(r.outcome).toBe("imported");
    const [q] = await admin<{ source: string; sales_owner_id: string; created_at: Date; source_connection_id: string }>(
      "select source, sales_owner_id, created_at, source_connection_id from public.inquiries where id = $1", [r.inquiry_id]);
    expect(q.source).toBe("google_sheet");
    expect(q.sales_owner_id).toBe(agentA.id);
    expect(q.source_connection_id).toBe(conn);
    expect(new Date(q.created_at).toISOString()).toBe("2026-10-01T06:15:00.000Z");
    const [v] = await admin<{ value: string }>("select value #>> '{}' as value from public.field_values where inquiry_id = $1 and field_id = $2", [r.inquiry_id, gradeField]);
    expect(v.value).toBe(grade11);
    const [act] = await admin<{ body: string; actor_id: string | null }>("select body, actor_id from public.activities where inquiry_id = $1 and type = 'imported'", [r.inquiry_id]);
    expect(act).toEqual({ body: "Imported from SAT Leads · Form Responses 1 (row 2)", actor_id: null });
  });

  it("the same row is never imported twice, even by two runs at once", async () => {
    const phone = newPhone();
    const results = await Promise.all([importRow("k-race", row(phone)), importRow("k-race", row(phone)), importRow("k-race", row(phone))]);
    expect(results.filter((r) => r.outcome === "imported")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "already")).toHaveLength(2);
    const rows = await admin("select 1 from public.inquiries i join public.contacts c on c.id = i.contact_id where c.phone_normalized = $1", [phone]);
    expect(rows).toHaveLength(1);
    expect((await importRow("k-race", row(phone))).outcome).toBe("already");
  });

  it("a customer who submits again is logged on their open inquiry, not duplicated", async () => {
    const phone = newPhone();
    const first = await importRow("k-resub-1", row(phone));
    const again = await importRow("k-resub-2", row(phone, { name: "Different spelling" }), 9);
    expect(again).toEqual({ outcome: "resubmitted", inquiry_id: first.inquiry_id });
    const [act] = await admin<{ body: string }>("select body from public.activities where inquiry_id = $1 and type = 'resubmitted'", [first.inquiry_id]);
    expect(act.body).toBe("Submitted the form again · SAT Leads · Form Responses 1 (row 9)");
    const notes = await admin("select 1 from public.notifications where user_id = $1 and inquiry_id = $2 and text like 'Submitted the form again%'", [agentA.id, first.inquiry_id]);
    expect(notes).toHaveLength(1);
    const [c] = await admin<{ name: string }>("select name from public.contacts where phone_normalized = $1", [phone]);
    expect(c.name).toBe("Sheet Lead"); // saved name kept
    const [l] = await admin<{ outcome: string }>("select outcome from public.sheet_rows where connection_id = $1 and row_key = 'k-resub-2'", [conn]);
    expect(l.outcome).toBe("resubmitted");
  });

  it("an existing customer asking about another program gets a new inquiry on the same contact", async () => {
    const phone = newPhone();
    const a = await importRow("k-prog-1", row(phone));
    const b = await importRow("k-prog-2", row(phone, { program_id: prog2 }));
    expect(b.outcome).toBe("imported");
    const contacts = await admin("select distinct contact_id from public.inquiries where id = any($1)", [[a.inquiry_id, b.inquiry_id]]);
    expect(contacts).toHaveLength(1);
    const [act] = await admin<{ body: string }>("select body from public.activities where inquiry_id = $1 and type = 'imported'", [b.inquiry_id]);
    expect(act.body).toMatch(/linked to existing contact/);
  });

  it("a value that does not fit a field is left empty and noted, the lead still arrives", async () => {
    const r = await importRow("k-badfield", row(newPhone(), { custom: { [examDate]: "next month", [gradeField]: "not-an-option" } }));
    expect(r.outcome).toBe("imported");
    const vals = await admin("select 1 from public.field_values where inquiry_id = $1", [r.inquiry_id]);
    expect(vals).toHaveLength(0);
    const [act] = await admin<{ body: string }>("select body from public.activities where inquiry_id = $1 and type = 'imported'", [r.inquiry_id]);
    expect(act.body).toMatch(/left empty \(value did not fit\): .*Import Exam Date.*Import Grade|left empty \(value did not fit\): .*Import Grade.*Import Exam Date/);
  });

  it("leads wait in the queue when nobody is on shift", async () => {
    const [{ id: lonely }] = await admin<{ id: string }>("insert into public.programs (code, name) values ('IMPC', 'Nobody') returning id");
    const r = await importRow("k-queue", row(newPhone(), { program_id: lonely }));
    const [q] = await admin<{ sales_owner_id: string | null }>("select sales_owner_id from public.inquiries where id = $1", [r.inquiry_id]);
    expect(q.sales_owner_id).toBeNull();
  });

  it("rows that existed before a 'new rows only' connection are never imported", async () => {
    const c2 = await as(manager, async (q) => (await q<{ id: string }>("select public.save_sheet_connection($1) as id", [{
      google_account_id: account, spreadsheet_id: "TESTsheet0000002", spreadsheet_name: "IELTS Leads", sheet_title: "Sheet1",
      sheet_gid: 0, program_id: prog, headers: ["Name", "Phone"],
      mapping: [{ column: 0, header: "Name", target: "name" }, { column: 1, header: "Phone", target: "phone" }],
      identity: "phone_program", import_mode: "new_only", baseline: [{ key: "old-1", row: 2 }, { key: "old-2", row: 3 }],
    }]))[0].id);
    expect((await importRow("old-1", row(newPhone()), 2, c2)).outcome).toBe("already");
    expect((await importRow("brand-new", row(newPhone()), 4, c2)).outcome).toBe("imported");
  });
});

describe("Needs Review", () => {
  let item: string;
  it("a flagged row is recorded once", async () => {
    const r = (await admin<{ r: { outcome: string; review_item_id: string } }>(
      "select private.flag_sheet_row($1, 'k-bad', 5, $2, $3, $4) as r",
      [conn, ["Phone number is missing"], { Name: "Mona", Phone: "" }, { name: "Mona" }]))[0].r;
    expect(r.outcome).toBe("review");
    item = r.review_item_id;
    const again = (await admin<{ r: { outcome: string } }>("select private.flag_sheet_row($1, 'k-bad', 5, $2, $3, $4) as r",
      [conn, ["Phone number is missing"], { Name: "Mona" }, {}]))[0].r;
    expect(again.outcome).toBe("already");
    expect((await importRow("k-bad", row(newPhone()))).outcome).toBe("already"); // a later run will not import it behind the manager's back
  });

  it("only managers can see or resolve it", async () => {
    expect(await as(agentA, (q) => q("select * from public.review_items"))).toHaveLength(0);
    expect(await as(agentA, (q) => q("select * from public.sheet_connections"))).toHaveLength(0);
    await expectError(as(agentA, (q) => q("select public.resolve_review_import($1, $2)", [item, row(newPhone())])), "CRM03");
    await expectError(as(agentA, (q) => q("select public.dismiss_review($1, 'spam')", [item])), "CRM03");
    expect(await as(manager, (q) => q("select * from public.review_items where id = $1", [item]))).toHaveLength(1);
  });

  it("fix and import creates the lead once", async () => {
    const phone = newPhone();
    const r = await as(manager, async (q) => (await q<{ r: { outcome: string; inquiry_id: string } }>(
      "select public.resolve_review_import($1, $2) as r", [item, row(phone, { name: "Mona Adel" })]))[0].r);
    expect(r.outcome).toBe("imported");
    const [it] = await admin<{ status: string; inquiry_id: string }>("select status, inquiry_id from public.review_items where id = $1", [item]);
    expect(it).toEqual({ status: "imported", inquiry_id: r.inquiry_id });
    const [act] = await admin<{ actor_id: string }>("select actor_id from public.activities where inquiry_id = $1 and type = 'imported'", [r.inquiry_id]);
    expect(act.actor_id).toBe(manager.id);
    await expectError(as(manager, (q) => q("select public.resolve_review_import($1, $2)", [item, row(newPhone())])), "CRM01", "already handled");
  });

  it("dismissing needs a reason", async () => {
    const r = (await admin<{ r: { review_item_id: string } }>("select private.flag_sheet_row($1, 'k-spam', 6, $2, $3, '{}') as r",
      [conn, ["Phone number is not valid: 123"], { Name: "test", Phone: "123" }]))[0].r;
    await expectError(as(manager, (q) => q("select public.dismiss_review($1, '  ')", [r.review_item_id])), "CRM01", "reason");
    await as(manager, (q) => q("select public.dismiss_review($1, 'Test entry')", [r.review_item_id]));
    const [l] = await admin<{ outcome: string }>("select outcome from public.sheet_rows where connection_id = $1 and row_key = 'k-spam'", [conn]);
    expect(l.outcome).toBe("dismissed");
  });
});

describe("connections and the Google sign-in", () => {
  it("nobody can read the stored token, not even a manager", async () => {
    await expectError(as(manager, (q) => q("select refresh_token_enc from public.google_accounts")), "42501");
    const visible = await as(manager, (q) => q<{ email: string }>("select email from public.google_accounts"));
    expect(visible.map((r) => r.email)).toContain("ammar.test@example.test");
    expect(await as(agentA, (q) => q("select email from public.google_accounts"))).toHaveLength(0);
    await expectError(as(manager, (q) => q("select private.save_google_account('x@example.test', 't', '', $1)", [manager.id])), "42501");
    await expectError(as(manager, (q) => q("select private.import_sheet_row($1, 'x', 1, '{}')", [conn])), "42501");
  });

  it("mapping must include name and phone, one column per field", async () => {
    const base = {
      google_account_id: account, spreadsheet_id: "TESTsheet0000003", spreadsheet_name: "Bad", sheet_title: "S", sheet_gid: 1,
      program_id: prog, headers: ["A", "B"], identity: "phone_program", import_mode: "all",
    };
    await expectError(as(manager, (q) => q("select public.save_sheet_connection($1)", [{ ...base, mapping: [{ column: 0, header: "A", target: "name" }] }])), "CRM01", "phone");
    await expectError(as(manager, (q) => q("select public.save_sheet_connection($1)", [{ ...base, mapping: [
      { column: 0, header: "A", target: "name" }, { column: 1, header: "B", target: "phone" }, { column: 2, header: "C", target: "phone" }] }])), "CRM01", "one column");
    await expectError(as(manager, (q) => q("select public.save_sheet_connection($1)", [{ ...base, identity: "timestamp_phone", mapping: [
      { column: 0, header: "A", target: "name" }, { column: 1, header: "B", target: "phone" }] }])), "CRM01", "timestamp");
    await expectError(as(agentA, (q) => q("select public.save_sheet_connection($1)", [{ ...base, mapping: [] }])), "CRM03");
  });

  it("a revoked Google sign-in pauses its connections and alerts managers once; reconnecting resumes them", async () => {
    await admin("select private.mark_google_reconnect($1, 'Google access was revoked')", [account]);
    await admin("select private.mark_google_reconnect($1, 'Google access was revoked')", [account]);
    const [c] = await admin<{ status: string }>("select status from public.sheet_connections where id = $1", [conn]);
    expect(c.status).toBe("reconnect");
    const notes = await admin("select 1 from public.notifications where user_id = $1 and text like 'Google Sheets stopped syncing%'", [manager.id]);
    expect(notes).toHaveLength(1);
    await admin("select private.save_google_account('ammar.test@example.test', 'v1:new', 'drive.file', $1)", [manager.id]);
    const [c2] = await admin<{ status: string }>("select status from public.sheet_connections where id = $1", [conn]);
    expect(c2.status).toBe("active");
  });

  it("a sync problem notifies managers when a working connection starts failing", async () => {
    await admin("select private.record_sync($1, 'needs_attention', 'Column \"Phone\" is missing', '{}')", [conn]);
    await admin("select private.record_sync($1, 'needs_attention', 'Column \"Phone\" is missing', '{}')", [conn]);
    const notes = await admin("select 1 from public.notifications where user_id = $1 and text like '%needs attention%'", [manager.id]);
    expect(notes).toHaveLength(1);
    await admin("select private.record_sync($1, 'active', null, $2)", [conn, { imported: 1 }]);
    const [c] = await admin<{ status: string; last_success_at: Date | null }>("select status, last_success_at from public.sheet_connections where id = $1", [conn]);
    expect(c.status).toBe("active");
    expect(c.last_success_at).not.toBeNull();
  });

  it("paused connections stay paused; removing one keeps its leads", async () => {
    await as(manager, (q) => q("select public.set_sheet_connection_paused($1, true)", [conn]));
    await admin("select private.record_sync($1, 'active', null, '{}')", [conn]);
    const [c] = await admin<{ status: string }>("select status from public.sheet_connections where id = $1", [conn]);
    expect(c.status).toBe("paused");
    const before = await admin<{ id: string }>("select id from public.inquiries where source_connection_id = $1", [conn]);
    expect(before.length).toBeGreaterThan(0);
    await as(manager, (q) => q("select public.delete_sheet_connection($1)", [conn]));
    const after = await admin<{ id: string }>("select id from public.inquiries where id = any($1)", [before.map((r) => r.id)]);
    expect(after).toHaveLength(before.length);
    expect(await admin("select 1 from public.sheet_connections where id = $1", [conn])).toHaveLength(0);
  });
});
