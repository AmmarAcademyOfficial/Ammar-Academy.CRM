import "server-only";
import { detectHeaderRow, suggestIdentity, suggestMapping, type ColumnMapping, type RowIdentity, type SuggestedColumn } from "@/domain/sheet-mapping";
import { displayCell, parseRow, type ParsedRow } from "@/domain/sheet-rows";
import { asSystem } from "../db";
import { dataRows, readTab, rowContext } from "./engine";

/** Used by the connect wizard (callers check that a manager is signed in). */

export interface PreviewRow {
  rowNumber: number;
  status: "new" | "existing_customer" | "resubmission" | "review";
  name: string;
  phone: string;
  program: string;
  problems: string[];
  details: { label: string; value: string }[];
}

export interface TabAnalysis {
  spreadsheet: { id: string; title: string; timeZone: string };
  tab: { gid: number; title: string };
  headerRow: number;
  headers: string[];
  /** First filled value of each column, as a person reads it. */
  samples: string[];
  mapping: SuggestedColumn[];
  identity: RowIdentity;
  preview: PreviewRow[];
  counts: { rows: number; ready: number; review: number; existingCustomers: number; resubmissions: number };
}

export interface AnalyzeInput {
  accountId: string;
  spreadsheetId: string;
  gid: number;
  programId: string;
  headerRow?: number;
  mapping?: ColumnMapping[];
  identity?: RowIdentity;
}

async function parseAll(input: AnalyzeInput) {
  const { info, tab, rows } = await readTab(input.accountId, input.spreadsheetId, input.gid);
  const headerRow = input.headerRow ?? detectHeaderRow(rows.slice(0, 5));
  const headers = (rows[headerRow - 1] ?? []).map((h) => String(h ?? "").trim());
  const ref = await asSystem((tx) => tx<{ id: string; key: string; label: string; archived: boolean }[]>`
    select id, key, label, archived from public.field_definitions`);
  const mapping: SuggestedColumn[] = input.mapping
    ? input.mapping.map((m) => ({ ...m, header: headers[m.column] ?? m.header, confidence: "sure" as const }))
    : suggestMapping(headers, ref);
  const identity = input.identity ?? suggestIdentity(mapping);
  const ctx = await asSystem((tx) => rowContext(tx, input.programId, identity, info.timeZone));
  const parsed: { rowNumber: number; row: Exclude<ParsedRow, { kind: "blank" }> }[] = [];
  const keys = new Set<string>();
  for (const { cells, rowNumber } of dataRows(rows, headerRow)) {
    const row = await parseRow(cells, mapping.filter((m) => m.target), ctx);
    if (row.kind === "blank" || keys.has(row.key)) continue; // a row repeated in the sheet counts once
    keys.add(row.key);
    parsed.push({ rowNumber, row });
  }
  const dateFields = new Set(ctx.fields.filter((f) => f.type === "date").map((f) => `field:${f.id}`));
  const samples = headers.map((_, col) => {
    const target = mapping.find((m) => m.column === col)?.target ?? "";
    const asDate = target === "submitted_at" ? "datetime" : dateFields.has(target) ? "date" : null;
    for (const r of rows.slice(headerRow, headerRow + 50)) {
      const v = displayCell(r[col], asDate, info.timeZone);
      if (v) return v.slice(0, 80);
    }
    return "";
  });
  return { info, tab, headerRow, headers, samples, mapping, identity, ctx, parsed };
}

export async function analyzeTab(input: AnalyzeInput): Promise<TabAnalysis> {
  const { info, tab, headerRow, headers, samples, mapping, identity, ctx, parsed } = await parseAll(input);

  // Which phones already belong to customers, and which have an open inquiry for the same program.
  const ok = parsed.filter((p) => p.row.kind === "ok").map((p) => (p.row as Extract<ParsedRow, { kind: "ok" }>).payload);
  const phones = [...new Set(ok.map((p) => p.phone_normalized))];
  const known = phones.length
    ? await asSystem((tx) => tx<{ phone: string; open_programs: string[] }[]>`
        select c.phone_normalized as phone,
          coalesce(array_agg(i.program_id::text) filter (where i.id is not null and not s.is_closed), '{}') as open_programs
        from public.contacts c
        left join public.inquiries i on i.contact_id = c.id
        left join public.stages s on s.id = i.stage_id
        where c.phone_normalized = any(${phones})
        group by c.phone_normalized`)
    : [];
  const knownMap = new Map(known.map((k) => [k.phone, k.open_programs]));
  const programCode = (id: string) => ctx.programs.find((p) => p.id === id)?.code ?? "";

  const counts = { rows: parsed.length, ready: 0, review: 0, existingCustomers: 0, resubmissions: 0 };
  const preview: PreviewRow[] = [];
  for (const { rowNumber, row } of parsed) {
    let status: PreviewRow["status"];
    if (row.kind === "review") {
      status = "review";
      counts.review++;
    } else {
      counts.ready++;
      const open = knownMap.get(row.payload.phone_normalized);
      status = !open ? "new" : open.includes(row.payload.program_id) ? "resubmission" : "existing_customer";
      if (status === "resubmission") counts.resubmissions++;
      if (status === "existing_customer") counts.existingCustomers++;
    }
    if (preview.length < 10) {
      const p = row.kind === "ok" ? row.payload : row.parsed;
      preview.push({
        rowNumber,
        status,
        name: p.name ?? "",
        phone: p.phone_normalized || p.phone || "",
        program: programCode(p.program_id ?? input.programId),
        problems: row.kind === "review" ? row.problems : [],
        details: Object.entries(row.raw).map(([label, value]) => ({ label, value })),
      });
    }
  }

  return {
    spreadsheet: { id: info.id, title: info.title, timeZone: info.timeZone },
    tab: { gid: tab.gid, title: tab.title },
    headerRow,
    headers,
    samples,
    mapping,
    identity,
    preview,
    counts,
  };
}

/** Keys of every row in the tab right now ("Only rows added from now on"). */
export async function currentRowKeys(input: AnalyzeInput): Promise<{ key: string; row: number }[]> {
  const { parsed } = await parseAll(input);
  return parsed.map((p) => ({ key: p.row.key, row: p.rowNumber }));
}
