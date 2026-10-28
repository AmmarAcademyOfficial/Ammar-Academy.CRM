import "server-only";
import { randomUUID } from "node:crypto";
import { normalizeHeader, type ColumnMapping, type RowIdentity } from "@/domain/sheet-mapping";
import { parseRow, type Cell, type ParsedRow, type RowContext } from "@/domain/sheet-rows";
import { decryptSecret } from "../crypto";
import { asSystem, type Tx } from "../db";
import { cleanupOrphanReceipts } from "../storage";
import { accessTokenFor, forgetAccessToken, google, GoogleAuthError, GoogleNotFoundError, GoogleTransientError, type SpreadsheetInfo } from "../google";

/**
 * The Google Sheets sync engine. Runs as the system (no signed-in user):
 * callers must check permissions first. Safe to run concurrently — the
 * sheet_rows ledger in the database decides which run imports a row.
 */

/** New rows handled per connection per run; a long history continues on the next run. */
export const ROWS_PER_RUN = 400;

interface ConnectionRow {
  id: string;
  google_account_id: string;
  spreadsheet_id: string;
  spreadsheet_name: string;
  sheet_title: string;
  sheet_gid: number;
  program_id: string;
  header_row: number;
  headers: string[];
  mapping: ColumnMapping[];
  identity: RowIdentity;
  status: string;
}

export interface SyncResult {
  connectionId: string;
  status: "active" | "needs_attention" | "unavailable" | "reconnect" | "retry" | "skipped";
  message: string | null;
  imported: number;
  resubmitted: number;
  review: number;
  failed: number;
  remaining: number;
}

// ── Google access ────────────────────────────────────────────────────────

async function tokenFor(accountId: string): Promise<string> {
  const [acc] = await asSystem((tx) => tx<{ refresh_token_enc: string | null; status: string }[]>`
    select refresh_token_enc, status from public.google_accounts where id = ${accountId}`);
  if (!acc?.refresh_token_enc || acc.status !== "connected") throw new GoogleAuthError("The Google account is not connected.");
  try {
    return await accessTokenFor(accountId, decryptSecret(acc.refresh_token_enc));
  } catch (e) {
    if (e instanceof GoogleAuthError) {
      forgetAccessToken(accountId);
      await asSystem((tx) => tx`select private.mark_google_reconnect(${accountId}, ${e.message})`);
    }
    throw e;
  }
}

/**
 * Runs a Google call with the account's access token. If Google rejects a cached token
 * (revoked or expired early), the token is dropped and refreshed once; if the refresh is
 * refused too, tokenFor marks the account and its connections "Reconnect".
 */
async function withToken<T>(accountId: string, fn: (token: string) => Promise<T>): Promise<T> {
  try {
    return await fn(await tokenFor(accountId));
  } catch (e) {
    if (!(e instanceof GoogleAuthError)) throw e;
    forgetAccessToken(accountId);
    return fn(await tokenFor(accountId));
  }
}

export async function openSpreadsheet(accountId: string, spreadsheetId: string): Promise<{ info: SpreadsheetInfo }> {
  return { info: await withToken(accountId, (t) => google().spreadsheet(t, spreadsheetId)) };
}

export async function readTab(accountId: string, spreadsheetId: string, gid: number) {
  return withToken(accountId, async (token) => {
    const info = await google().spreadsheet(token, spreadsheetId);
    const tab = info.tabs.find((t) => t.gid === gid);
    if (!tab) throw new GoogleNotFoundError("The connected tab was deleted from the spreadsheet.");
    const rows = await google().values(token, spreadsheetId, tab.title);
    return { info, tab, rows };
  });
}

// ── Reference data for parsing ───────────────────────────────────────────

export async function rowContext(tx: Tx, defaultProgramId: string, identity: RowIdentity, timeZone: string): Promise<RowContext> {
  const programs = await tx<RowContext["programs"]>`select id, code, name, active from public.programs`;
  const fields = await tx<{ id: string; label: string; type: string; archived: boolean; program_ids: string[]; options: { id: string; label: string; archived: boolean }[] }[]>`
    select f.id, f.label, f.type, f.archived, f.program_ids,
      coalesce((select json_agg(json_build_object('id', o.id, 'label', o.label, 'archived', o.archived) order by o.sort)
                from public.field_options o where o.field_id = f.id), '[]') as options
    from public.field_definitions f`;
  return {
    programs: programs.map((p) => ({ ...p })),
    defaultProgramId,
    identity,
    timeZone,
    fields: fields.map((f) => ({ id: f.id, label: f.label, type: f.type as RowContext["fields"][number]["type"], archived: f.archived, programIds: f.program_ids, options: f.options })),
  };
}

/**
 * Finds each mapped column in the current header row. A column that moved is
 * followed by its header text; one that was renamed or deleted is reported.
 */
export function resolveColumns(mapping: ColumnMapping[], headers: string[]): { mapping: ColumnMapping[]; missing: string[] } {
  const norm = headers.map((h) => normalizeHeader(String(h ?? "")));
  const missing: string[] = [];
  const out: ColumnMapping[] = [];
  for (const m of mapping) {
    if (!m.target) continue;
    const want = normalizeHeader(m.header);
    if (norm[m.column] === want) out.push(m);
    else {
      const at = norm.indexOf(want);
      if (at >= 0) out.push({ ...m, column: at });
      else missing.push(m.header);
    }
  }
  return { mapping: out, missing };
}

export function dataRows(rows: Cell[][], headerRow: number): { cells: Cell[]; rowNumber: number }[] {
  return rows.slice(headerRow).map((cells, i) => ({ cells, rowNumber: headerRow + i + 1 }));
}

// ── One connection ───────────────────────────────────────────────────────

export async function syncConnection(connectionId: string): Promise<SyncResult> {
  const result: SyncResult = { connectionId, status: "active", message: null, imported: 0, resubmitted: 0, review: 0, failed: 0, remaining: 0 };
  const [c] = await asSystem((tx) => tx<ConnectionRow[]>`select * from public.sheet_connections where id = ${connectionId}`);
  if (!c || c.status === "paused") return { ...result, status: "skipped" };

  const record = (status: string, message: string | null, run: object | null) =>
    asSystem((tx) => tx`select private.record_sync(${c.id}, ${status}, ${message}, ${run ? tx.json(run as never) : null})`);

  let info: SpreadsheetInfo, rows: Cell[][];
  try {
    ({ info, rows } = await readTab(c.google_account_id, c.spreadsheet_id, Number(c.sheet_gid)));
  } catch (e) {
    if (e instanceof GoogleAuthError) return { ...result, status: "reconnect", message: e.message };
    if (e instanceof GoogleNotFoundError) {
      await record("unavailable", e.message, null);
      return { ...result, status: "unavailable", message: e.message };
    }
    const message = e instanceof GoogleTransientError ? e.message : "Unexpected error while reading the sheet. Will try again.";
    await asSystem((tx) => tx`update public.sheet_connections set last_checked_at = now(), status_message = ${message} where id = ${c.id}`);
    return { ...result, status: "retry", message };
  }

  const headers = (rows[c.header_row - 1] ?? []).map((h) => String(h ?? ""));
  const { mapping, missing } = resolveColumns(c.mapping, headers);
  // Name, phone, program and the row-identity column are essential: without them a row could be
  // misread or imported twice, so syncing stops until a manager matches them again.
  const essential = new Set(["name", "phone", "program", c.identity === "lead_id" ? "lead_id" : c.identity === "timestamp_phone" ? "submitted_at" : "phone"]);
  const essentialMissing = c.mapping.filter((m) => essential.has(m.target) && missing.includes(m.header)).map((m) => m.header);
  const quote = (hs: string[]) => hs.map((h) => `"${h}"`).join(", ");
  if (essentialMissing.length) {
    const many = essentialMissing.length > 1;
    const message = `Column${many ? "s" : ""} ${quote(essentialMissing)} ${many ? "were" : "was"} renamed or removed in the sheet. Open the connection and match ${many ? "them" : "it"} again.`;
    await record("needs_attention", message, null);
    return { ...result, status: "needs_attention", message };
  }
  const warning = missing.length ? `Column${missing.length > 1 ? "s" : ""} ${quote(missing)} no longer found; those answers are skipped until matched again.` : null;
  const stored = c.mapping.filter((m) => m.target && !missing.includes(m.header));
  if (!missing.length && mapping.some((m, i) => m.column !== stored[i].column)) {
    // Columns moved but are all still there: remember the new positions.
    await asSystem((tx) => tx`update public.sheet_connections set mapping = ${tx.json(mapping as never)} where id = ${c.id}`);
  }

  const ctx = await asSystem((tx) => rowContext(tx, c.program_id, c.identity, info.timeZone));
  const seen = new Set((await asSystem((tx) => tx<{ row_key: string }[]>`
    select row_key from public.sheet_rows where connection_id = ${c.id}`)).map((r) => r.row_key));

  let handled = 0;
  for (const { cells, rowNumber } of dataRows(rows, c.header_row)) {
    const parsed = await parseRow(cells, mapping, ctx);
    if (parsed.kind === "blank" || seen.has(parsed.key)) continue;
    if (handled >= ROWS_PER_RUN) {
      result.remaining++;
      continue;
    }
    handled++;
    seen.add(parsed.key);
    await handleRow(c.id, parsed, rowNumber, result);
  }

  const run = { imported: result.imported, resubmitted: result.resubmitted, review: result.review, failed: result.failed, remaining: result.remaining, at: new Date().toISOString() };
  const message = result.remaining > 0
    ? `Importing earlier rows: ${result.remaining} still to go. They continue automatically.`
    : result.failed > 0 ? `${result.failed} row(s) could not be imported and will be retried.` : warning;
  await record("active", message, run);
  result.message = message;
  return result;
}

async function handleRow(connectionId: string, parsed: Exclude<ParsedRow, { kind: "blank" }>, rowNumber: number, result: SyncResult) {
  if (parsed.kind === "review") {
    const [{ r }] = await asSystem((tx) => tx<{ r: { outcome: string } }[]>`
      select private.flag_sheet_row(${connectionId}, ${parsed.key}, ${rowNumber}, ${parsed.problems}, ${tx.json(parsed.raw)}, ${tx.json(parsed.parsed as never)}) as r`);
    if (r.outcome === "review") result.review++;
    return;
  }
  try {
    const [{ r }] = await asSystem((tx) => tx<{ r: { outcome: string } }[]>`
      select private.import_sheet_row(${connectionId}, ${parsed.key}, ${rowNumber}, ${tx.json(parsed.payload as never)}) as r`);
    if (r.outcome === "imported") result.imported++;
    else if (r.outcome === "resubmitted") result.resubmitted++;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "CRM01") {
      // A rule the parser did not anticipate: send the row to a person instead of retrying forever.
      await asSystem((tx) => tx`select private.flag_sheet_row(${connectionId}, ${parsed.key}, ${rowNumber}, ${[err.message ?? "Could not import"]}, ${tx.json(parsed.raw)}, ${tx.json(parsed.payload as never)})`);
      result.review++;
    } else {
      result.failed++;
      console.error("[sheets] row import failed", { connectionId, rowNumber, code: err.code });
    }
  }
}

// ── Everything (the 2-minute run) ────────────────────────────────────────

export interface TickResult {
  ran: boolean;
  connections: SyncResult[];
  assignment: { assigned: number; waiting: number; pauses_ended: number } | null;
  ms: number;
  cleanup: { checked: number; deleted: number } | null;
  /** "Not opened yet" alerts and follow-up reminders sent this run. */
  alerts: { unopened: number; reminders: number } | null;
}

/** Syncs every connection, then assigns waiting leads. Overlapping runs skip instead of piling up. */
export async function runTick(): Promise<TickResult> {
  const started = Date.now();
  // A lease in the database (not a session lock): if this instance stops mid-run, for example
  // during a deploy, the lease simply expires and the next tick goes ahead.
  const holder = randomUUID();
  const [{ ok }] = await asSystem((tx) => tx<{ ok: boolean }[]>`select private.try_start_tick(${holder}, 360) as ok`);
  if (!ok) return { ran: false, connections: [], assignment: null, ms: Date.now() - started, cleanup: null, alerts: null };
  try {
    const conns = await asSystem((tx) => tx<{ id: string }[]>`
      select c.id from public.sheet_connections c join public.google_accounts a on a.id = c.google_account_id
      where c.status <> 'paused' and a.status = 'connected' order by c.created_at`);
    const connections: SyncResult[] = [];
    for (const { id } of conns) {
      try {
        connections.push(await syncConnection(id));
      } catch (e) {
        console.error("[sheets] connection sync failed", { id, error: (e as Error).message });
        connections.push({ connectionId: id, status: "retry", message: "Unexpected error", imported: 0, resubmitted: 0, review: 0, failed: 0, remaining: 0 });
      }
    }
    const [{ r }] = await asSystem((tx) => tx<{ r: TickResult["assignment"] }[]>`select private.assign_waiting(now()) as r`);
    // Timed notifications: leads not opened in time, and follow-up reminders.
    let alerts: TickResult["alerts"] = null;
    try {
      [{ alerts }] = await asSystem((tx) => tx<{ alerts: TickResult["alerts"] }[]>`select private.send_timed_alerts(now()) as alerts`);
    } catch (e) {
      console.error("[alerts] timed alerts failed", (e as Error).message);
    }
    // Housekeeping once an hour (the tick runs every 2 minutes, so exactly one run lands in minutes 0–1).
    let cleanup: TickResult["cleanup"] = null;
    if (new Date().getUTCMinutes() < 2) {
      try {
        // Deleted records past their 30 days go first, so their receipts become unused and are removed too.
        await asSystem((tx) => tx`select private.purge_deleted(now())`);
        cleanup = await cleanupOrphanReceipts();
      } catch (e) {
        console.error("[cleanup] receipts", (e as Error).message);
      }
    }
    return { ran: true, connections, assignment: r, ms: Date.now() - started, cleanup, alerts };
  } finally {
    await asSystem((tx) => tx`select private.end_tick(${holder})`).catch((e) => console.error("[tick] could not release the lease", (e as Error).message));
  }
}
