"use server";

/**
 * Google Sheets connections and Needs Review. Manager only.
 * Reading Google runs on the server with the stored (encrypted) sign-in;
 * every change to CRM data goes through a database function as the manager.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { mappingProblems, type ColumnMapping, type RowIdentity } from "@/domain/sheet-mapping";
import { normalizePhone } from "@/domain/rules";
import { requireStaff, type Staff } from "./auth";
import { decryptSecret } from "./crypto";
import { asSystem, asUser } from "./db";
import { forgetAccessToken, google } from "./google";
import { attempt, forbidden, type Result, ValidationError } from "./result";
import { openSpreadsheet, syncConnection, type SyncResult } from "./sheets/engine";
import { analyzeTab, currentRowKeys, type TabAnalysis } from "./sheets/inspect";

const uuid = z.string().uuid();
const spreadsheetId = z.string().regex(/^[A-Za-z0-9_-]{10,100}$/, "That is not a Google Sheets file.");
const target = z.union([
  z.enum(["", "name", "phone", "phone_secondary", "program", "student_name", "contact_type", "submitted_at", "lead_id", "note"]),
  z.string().regex(/^field:[0-9a-f-]{36}$/),
]);
const mappingSchema = z.array(z.object({ column: z.number().int().min(0).max(700), header: z.string().max(300), target })).max(700);
const identitySchema = z.enum(["lead_id", "timestamp_phone", "phone_program"]);

async function manager(): Promise<Staff> {
  const staff = await requireStaff();
  if (staff.role !== "manager") forbidden("Only managers can manage Google Sheets connections.");
  return staff;
}

async function connectedAccount(staff: Staff): Promise<string> {
  const [a] = await asUser(staff.id, (tx) => tx<{ id: string }[]>`
    select id from public.google_accounts where status = 'connected' order by connected_at desc limit 1`);
  if (!a) throw new ValidationError("Connect a Google account first.");
  return a.id;
}

const refresh = () => {
  revalidatePath("/settings/sheets");
  revalidatePath("/review");
};

/** Step 2 of the wizard: the file the manager picked → its tabs. */
export async function inspectSpreadsheet(id: string): Promise<Result<{ id: string; title: string; tabs: { gid: number; title: string; rows: number }[] }>> {
  return attempt(async () => {
    const staff = await manager();
    const sid = spreadsheetId.parse(id);
    const { info } = await openSpreadsheet(await connectedAccount(staff), sid);
    return { id: info.id, title: info.title, tabs: info.tabs };
  });
}

/** Step 3: headers, suggested mapping and a 10-row preview. Pass a mapping to preview a manual change. */
export async function analyzeSheetTab(input: { spreadsheetId: string; gid: number; programId: string; headerRow?: number; mapping?: ColumnMapping[]; identity?: RowIdentity }): Promise<Result<TabAnalysis>> {
  return attempt(async () => {
    const staff = await manager();
    return analyzeTab({
      accountId: await connectedAccount(staff),
      spreadsheetId: spreadsheetId.parse(input.spreadsheetId),
      gid: z.number().int().min(0).parse(input.gid),
      programId: uuid.parse(input.programId),
      headerRow: input.headerRow === undefined ? undefined : z.number().int().min(1).max(20).parse(input.headerRow),
      mapping: input.mapping ? (mappingSchema.parse(input.mapping) as ColumnMapping[]) : undefined,
      identity: input.identity ? identitySchema.parse(input.identity) : undefined,
    });
  });
}

const createSchema = z.object({
  spreadsheetId,
  gid: z.number().int().min(0),
  programId: uuid,
  headerRow: z.number().int().min(1).max(20),
  mapping: mappingSchema,
  identity: identitySchema,
  importMode: z.enum(["all", "new_only"]),
});

/** Step 4: save and start syncing. "All rows" imports right away; "new rows only" records what is there now. */
export async function createSheetConnection(input: z.infer<typeof createSchema>): Promise<Result<{ id: string; firstRun: SyncResult | null }>> {
  return attempt(async () => {
    const staff = await manager();
    const v = createSchema.parse(input);
    const problems = mappingProblems(v.mapping as ColumnMapping[], v.identity);
    if (problems.length) throw new ValidationError(problems[0], problems);
    const accountId = await connectedAccount(staff);
    const { info } = await openSpreadsheet(accountId, v.spreadsheetId);
    const tab = info.tabs.find((t) => t.gid === v.gid);
    if (!tab) throw new ValidationError("That tab no longer exists in the spreadsheet.");
    const mapping = v.mapping.filter((m) => m.target);
    // The baseline is computed here on the server from Google's data, never taken from the browser.
    const baseline = v.importMode === "new_only"
      ? await currentRowKeys({ accountId, spreadsheetId: v.spreadsheetId, gid: v.gid, programId: v.programId, headerRow: v.headerRow, mapping: mapping as ColumnMapping[], identity: v.identity })
      : [];
    const [{ id }] = await asUser(staff.id, (tx) => tx<{ id: string }[]>`select public.save_sheet_connection(${tx.json({
      google_account_id: accountId,
      spreadsheet_id: v.spreadsheetId,
      spreadsheet_name: info.title,
      sheet_title: tab.title,
      sheet_gid: v.gid,
      program_id: v.programId,
      header_row: v.headerRow,
      headers: v.mapping.map((m) => m.header),
      mapping,
      identity: v.identity,
      import_mode: v.importMode,
      baseline,
    } as never)}) as id`);
    const firstRun = await syncConnection(id);
    refresh();
    return { id, firstRun };
  });
}

export async function updateSheetMapping(id: string, input: { programId: string; headerRow: number; mapping: ColumnMapping[]; identity: RowIdentity }): Promise<Result<SyncResult>> {
  return attempt(async () => {
    const staff = await manager();
    const mapping = mappingSchema.parse(input.mapping);
    const identity = identitySchema.parse(input.identity);
    const problems = mappingProblems(mapping as ColumnMapping[], identity);
    if (problems.length) throw new ValidationError(problems[0], problems);
    const connId = uuid.parse(id);
    await asUser(staff.id, async (tx) => {
      const [c] = await tx<{ google_account_id: string }[]>`select google_account_id from public.sheet_connections where id = ${connId}`;
      if (!c) throw Object.assign(new Error("Connection not found."), { code: "CRM04" });
      await tx`select public.save_sheet_connection(${tx.json({
        id: connId,
        google_account_id: c.google_account_id,
        program_id: uuid.parse(input.programId),
        header_row: z.number().int().min(1).max(20).parse(input.headerRow),
        headers: mapping.map((m) => m.header),
        mapping: mapping.filter((m) => m.target),
        identity,
      } as never)})`;
    });
    const r = await syncConnection(id);
    refresh();
    return r;
  });
}

export async function syncSheetNow(id: string): Promise<Result<SyncResult>> {
  return attempt(async () => {
    await manager();
    const r = await syncConnection(uuid.parse(id));
    await asSystem((tx) => tx`select private.assign_waiting(now())`);
    refresh();
    return r;
  });
}

export async function setSheetPaused(id: string, paused: boolean): Promise<Result<void>> {
  return attempt(async () => {
    const staff = await manager();
    await asUser(staff.id, (tx) => tx`select public.set_sheet_connection_paused(${uuid.parse(id)}, ${paused})`);
    if (!paused) await syncConnection(id);
    refresh();
  });
}

export async function removeSheetConnection(id: string): Promise<Result<void>> {
  return attempt(async () => {
    const staff = await manager();
    await asUser(staff.id, (tx) => tx`select public.delete_sheet_connection(${uuid.parse(id)})`);
    refresh();
  });
}

/** Forgets the Google sign-in here and asks Google to revoke it too. */
export async function disconnectGoogle(accountId: string): Promise<Result<void>> {
  return attempt(async () => {
    const staff = await manager();
    const id = uuid.parse(accountId);
    const [acc] = await asSystem((tx) => tx<{ refresh_token_enc: string | null }[]>`select refresh_token_enc from public.google_accounts where id = ${id}`);
    await asUser(staff.id, (tx) => tx`select public.disconnect_google_account(${id})`);
    forgetAccessToken(id);
    if (acc?.refresh_token_enc) await google().revoke(decryptSecret(acc.refresh_token_enc)).catch(() => undefined);
    refresh();
  });
}

// ── Needs Review ─────────────────────────────────────────────────────────

const fixSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  phone: z.string().trim().min(1, "Phone is required."),
  programId: uuid,
  studentName: z.string().trim().max(120).optional(),
  contactType: z.enum(["student", "parent", "other"]).default("student"),
});

export async function importReviewedRow(id: string, input: z.infer<typeof fixSchema>): Promise<Result<{ inquiryId: string; outcome: string }>> {
  return attempt(async () => {
    const staff = await manager();
    const v = fixSchema.parse(input);
    const phone = normalizePhone(v.phone);
    if (!/^\+?\d{8,15}$/.test(phone)) throw new ValidationError("Enter a valid phone number.");
    const [{ r }] = await asUser(staff.id, (tx) => tx<{ r: { outcome: string; inquiry_id: string } }[]>`
      select public.resolve_review_import(${uuid.parse(id)}, ${tx.json({
        name: v.name, phone: v.phone, phone_normalized: phone, program_id: v.programId,
        student_name: v.studentName || null, contact_type: v.contactType, custom: {},
      })}) as r`);
    refresh();
    return { inquiryId: r.inquiry_id, outcome: r.outcome };
  });
}

export async function dismissReviewItem(id: string, note: string): Promise<Result<void>> {
  return attempt(async () => {
    const staff = await manager();
    await asUser(staff.id, (tx) => tx`select public.dismiss_review(${uuid.parse(id)}, ${z.string().max(300).parse(note)})`);
    refresh();
  });
}
