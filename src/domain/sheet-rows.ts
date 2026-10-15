/**
 * Turns one Google Sheet row into a CRM import payload, or explains in plain
 * English why it needs review. Pure functions: no Google, no database.
 *
 * Cells arrive as Google returns them with valueRenderOption=UNFORMATTED_VALUE
 * and dateTimeRenderOption=SERIAL_NUMBER: text as strings, numbers as numbers,
 * dates and times as day serials in the spreadsheet's own time zone. Reading
 * serials avoids guessing whether "05/06/2026" means May or June.
 */
import { latinDigits, normalizePhone } from "./rules";
import { normalizeHeader, type ColumnMapping, type RowIdentity } from "./sheet-mapping";
import type { FieldDefinition } from "./types";

export type Cell = string | number | boolean | null | undefined;

export interface RowContext {
  programs: { id: string; code: string; name: string; active: boolean }[];
  defaultProgramId: string;
  fields: (Pick<FieldDefinition, "id" | "label" | "type" | "archived" | "programIds"> & { options?: { id: string; label: string; archived?: boolean }[] })[];
  /** Spreadsheet time zone (IANA), e.g. "Africa/Cairo". */
  timeZone: string;
  identity: RowIdentity;
}

/** What create_imported_inquiry expects. */
export interface ImportPayload {
  name: string;
  phone: string;
  phone_normalized: string;
  phone_secondary?: string | null;
  phone_secondary_normalized?: string | null;
  program_id: string;
  student_name?: string | null;
  contact_type: "student" | "parent" | "other";
  submitted_at?: string | null;
  custom: Record<string, string | number | boolean>;
  extra_note?: string;
}

export type ParsedRow =
  | { kind: "blank" }
  | { kind: "ok"; key: string; payload: ImportPayload; raw: Record<string, string> }
  | { kind: "review"; key: string; problems: string[]; raw: Record<string, string>; parsed: Partial<ImportPayload> };

// ── Dates ────────────────────────────────────────────────────────────────

const SERIAL_EPOCH_MS = Date.UTC(1899, 11, 30);

function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** A spreadsheet day serial (local wall time in `timeZone`) → ISO instant. */
export function serialToIso(serial: number, timeZone: string): string {
  const wall = SERIAL_EPOCH_MS + Math.round(serial * 86_400_000);
  let utc = wall - tzOffsetMs(wall, timeZone);
  utc = wall - tzOffsetMs(utc, timeZone); // second pass settles daylight-saving edges
  return new Date(utc).toISOString();
}

/** A day serial → YYYY-MM-DD (calendar date as written in the sheet). */
export function serialToDate(serial: number): string {
  return new Date(SERIAL_EPOCH_MS + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
}

/** How a cell reads to a person (used for Needs Review and previews). */
export function displayCell(cell: Cell, asDate: "datetime" | "date" | null, timeZone: string): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "number" && asDate) {
    const iso = serialToIso(cell, timeZone);
    const d = new Date(iso);
    return asDate === "date"
      ? serialToDate(cell)
      : new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  }
  if (typeof cell === "number") return Number.isInteger(cell) ? String(cell) : String(cell);
  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
  return cell.trim();
}

function text(cell: Cell): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "number") return Number.isInteger(cell) ? cell.toFixed(0) : String(cell);
  return String(cell).replace(/\s+/g, " ").trim();
}

function parseDateCell(cell: Cell): string | null {
  if (typeof cell === "number" && cell > 20000 && cell < 80000) return serialToDate(cell);
  const s = latinDigits(text(cell));
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return null; // ambiguous formats are not guessed
}

function parseTimestamp(cell: Cell, timeZone: string): string | null {
  if (typeof cell === "number" && cell > 20000 && cell < 80000) return serialToIso(cell, timeZone);
  const s = text(cell);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s))) return new Date(s).toISOString(); // e.g. Facebook created_time
  return null;
}

// ── Values ───────────────────────────────────────────────────────────────

const PROGRAM_ALIASES: Record<string, string[]> = {
  SAT: ["sat", "سات", "digital sat", "dsat", "ديجيتال سات"],
  IELTS: ["ielts", "ايلتس", "ايلتس اكاديمي", "ايلتس جنرال", "الايلتس"],
  ACT: ["act", "اكت"],
  EST: ["est", "اي اس تي"],
};

/** Matches a cell like "Digital SAT", "IELTS Academic" or "سات" to one active program. */
export function matchProgram(value: string, programs: RowContext["programs"]): string | null | "ambiguous" {
  const v = normalizeHeader(latinDigits(value));
  if (!v) return null;
  const hits = programs.filter((p) => {
    if (!p.active) return false;
    const phrases = [p.code.toLowerCase(), normalizeHeader(p.name), ...(PROGRAM_ALIASES[p.code] ?? [])];
    return phrases.some((ph) => ph && (v === ph || ` ${v} `.includes(` ${ph} `)));
  });
  if (hits.length === 1) return hits[0].id;
  return hits.length > 1 ? "ambiguous" : null;
}

function contactType(value: string): ImportPayload["contact_type"] | null {
  const v = normalizeHeader(value);
  if (!v) return null;
  if (/(parent|guardian|father|mother|mom|dad|ولي|والد|والده|ام |اب )/.test(` ${v} `)) return "parent";
  if (/(student|طالب|طالبه|انا الطالب)/.test(v)) return "student";
  return "other";
}

const YES = new Set(["yes", "y", "true", "1", "نعم", "ايوه", "اه", "صح", "checked"]);
const NO = new Set(["no", "n", "false", "0", "لا", "لأ"]);

function fieldValue(field: RowContext["fields"][number], cell: Cell): string | number | boolean | null {
  const s = latinDigits(text(cell));
  if (!s) return null;
  switch (field.type) {
    case "number": {
      if (typeof cell === "number") return cell;
      const n = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
      return n ? Number(n[0]) : s; // the database notes it as "did not fit"
    }
    case "date":
      return parseDateCell(cell) ?? s;
    case "checkbox": {
      const v = normalizeHeader(s);
      if (YES.has(v)) return true;
      if (NO.has(v)) return false;
      return null;
    }
    case "dropdown": {
      const v = normalizeHeader(s);
      const opt = field.options?.find((o) => !o.archived && normalizeHeader(o.label) === v)
        ?? field.options?.find((o) => !o.archived && (normalizeHeader(o.label).includes(v) || v.includes(normalizeHeader(o.label))));
      return opt ? opt.id : s; // unmatched text is left empty and noted on the timeline
    }
    case "phone":
      return normalizePhone(s) || s;
    default:
      return s.slice(0, 500);
  }
}

// ── Row identity ─────────────────────────────────────────────────────────

/** Stable, non-reversible row key (the raw values never leave this function). */
export async function rowKey(parts: string[]): Promise<string> {
  const data = new TextEncoder().encode(parts.join("␟"));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Parsing ──────────────────────────────────────────────────────────────

function phoneProblem(raw: string, normalized: string): string | null {
  if (!raw) return "Phone number is missing";
  const digits = normalized.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return `Phone number is not valid: "${raw}"`;
  if (normalized.startsWith("+20") && !/^\+201[0125]\d{8}$/.test(normalized)) return `Not a valid Egyptian mobile number: "${raw}"`;
  return null;
}

export async function parseRow(cells: Cell[], mapping: ColumnMapping[], ctx: RowContext): Promise<ParsedRow> {
  const col = (target: string) => mapping.find((m) => m.target === target);
  const cellOf = (target: string): Cell => {
    const m = col(target);
    return m ? cells[m.column] : undefined;
  };

  const dateTargets = new Set(ctx.fields.filter((f) => f.type === "date").map((f) => `field:${f.id}`));
  const raw: Record<string, string> = {};
  mapping.forEach((m) => {
    const asDate = m.target === "submitted_at" ? "datetime" : dateTargets.has(m.target) ? "date" : null;
    const v = displayCell(cells[m.column], asDate, ctx.timeZone);
    if (v) raw[m.header || `Column ${m.column + 1}`] = v;
  });

  const nameRaw = text(cellOf("name"));
  const studentRaw = text(cellOf("student_name"));
  const phoneRaw = text(cellOf("phone"));
  const tsCell = cellOf("submitted_at");
  const leadId = text(cellOf("lead_id"));
  if (!nameRaw && !phoneRaw && !studentRaw && !leadId) return { kind: "blank" };

  const problems: string[] = [];
  const name = (nameRaw || studentRaw).slice(0, 120);
  if (!name) problems.push("Name is missing");

  const phone = normalizePhone(phoneRaw);
  const pp = phoneProblem(phoneRaw, phone);
  if (pp) problems.push(pp);

  let programId = ctx.defaultProgramId;
  const programCell = text(cellOf("program"));
  if (programCell) {
    const p = matchProgram(programCell, ctx.programs);
    if (p === null) problems.push(`Program "${programCell}" is not one of the CRM programs`);
    else if (p === "ambiguous") problems.push(`Program "${programCell}" matches more than one program`);
    else programId = p;
  }

  const secondaryRaw = text(cellOf("phone_secondary"));
  const secondary = secondaryRaw ? normalizePhone(secondaryRaw) : "";
  const secondaryOk = secondary && !phoneProblem(secondaryRaw, secondary) && secondary !== phone;

  const typeCell = text(cellOf("contact_type"));
  const type = contactType(typeCell) ?? (studentRaw && nameRaw && studentRaw !== nameRaw ? "parent" : "student");

  const custom: ImportPayload["custom"] = {};
  for (const m of mapping) {
    if (!m.target.startsWith("field:")) continue;
    const field = ctx.fields.find((f) => `field:${f.id}` === m.target);
    if (!field || field.archived) continue;
    if (field.programIds.length > 0 && !field.programIds.includes(programId)) continue;
    const v = fieldValue(field, cells[m.column]);
    if (v !== null && v !== "") custom[field.id] = v;
  }

  const noteLines = mapping
    .filter((m) => m.target === "note")
    .map((m) => [m.header, text(cells[m.column])] as const)
    .filter(([, v]) => v)
    .map(([h, v]) => `${h}: ${v}`);

  const payload: ImportPayload = {
    name,
    phone: phoneRaw,
    phone_normalized: phone,
    phone_secondary: secondaryOk ? secondaryRaw : null,
    phone_secondary_normalized: secondaryOk ? secondary : null,
    program_id: programId,
    student_name: nameRaw && studentRaw && studentRaw !== nameRaw ? studentRaw.slice(0, 120) : null,
    contact_type: type,
    submitted_at: parseTimestamp(tsCell, ctx.timeZone),
    custom,
    extra_note: noteLines.length ? noteLines.join("\n").slice(0, 4000) : undefined,
  };

  // Identity uses the cells as written, so fixing nothing in the sheet keeps the same key.
  let parts: string[];
  if (ctx.identity === "lead_id" && leadId) parts = ["id", leadId];
  else if (ctx.identity === "timestamp_phone" && tsCell !== undefined && text(tsCell)) parts = ["tp", text(tsCell), phoneRaw.replace(/\D/g, "")];
  else parts = ["pp", phone || phoneRaw, programId, (payload.student_name ?? "").toLowerCase()];
  const key = await rowKey(parts);

  if (problems.length) return { kind: "review", key, problems, raw, parsed: payload };
  return { kind: "ok", key, payload, raw };
}
