import "server-only";
import type { DistributionData, EligibilityRow, GoogleAccountDTO, ReviewItemDTO, SheetConnectionDTO, SheetHealth, SheetsPageData } from "@/domain/dto";
import type { IneligibleReason } from "@/domain/rules";
import type { Staff } from "./auth";
import { asUser, type Tx } from "./db";
import { env } from "./env";

/** Reads for Phase 3 screens. All run as the signed-in user; RLS limits them to managers. */

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export async function eligibilityRows(tx: Tx): Promise<EligibilityRow[]> {
  const rows = await tx<Row[]>`select * from public.eligibility_now()`;
  return rows.map((r) => ({
    userId: String(r.user_id),
    programId: String(r.program_id),
    reason: (r.reason as IneligibleReason | null) ?? null,
    openLeads: Number(r.open_leads),
    onShiftUntil: (r.on_shift_until as string | null) ?? null,
  }));
}

function mapHealth(r: Row): SheetHealth {
  return {
    id: String(r.id),
    name: String(r.spreadsheet_name),
    tab: String(r.sheet_title),
    status: r.status as SheetHealth["status"],
    statusMessage: (r.status_message as string | null) ?? null,
    lastSuccessAt: iso(r.last_success_at),
    lastCheckedAt: iso(r.last_checked_at),
  };
}

export async function sheetHealth(tx: Tx): Promise<SheetHealth[]> {
  return (await tx<Row[]>`select * from public.sheet_connections order by created_at`).map(mapHealth);
}

export async function openReviewCount(tx: Tx): Promise<number> {
  const [{ n }] = await tx<Row[]>`select count(*) as n from public.review_items where status = 'open'`;
  return Number(n);
}

export async function sheetsPage(staff: Staff): Promise<SheetsPageData> {
  return asUser(staff.id, async (tx) => {
    const [accounts, conns, reviewOpen] = await Promise.all([
      tx<Row[]>`select id, email, status, last_error, connected_at from public.google_accounts where status <> 'disconnected' order by connected_at desc`,
      tx<Row[]>`select * from public.sheet_connections order by created_at`,
      openReviewCount(tx),
    ]);
    return {
      mode: env().GOOGLE_MODE,
      accounts: accounts.map((a): GoogleAccountDTO => ({
        id: String(a.id), email: String(a.email), status: a.status as GoogleAccountDTO["status"],
        lastError: (a.last_error as string | null) ?? null, connectedAt: iso(a.connected_at)!,
      })),
      connections: conns.map((c): SheetConnectionDTO => ({
        ...mapHealth(c),
        googleAccountId: String(c.google_account_id),
        spreadsheetId: String(c.spreadsheet_id),
        sheetGid: Number(c.sheet_gid),
        programId: String(c.program_id),
        headerRow: Number(c.header_row),
        headers: c.headers as string[],
        mapping: c.mapping as SheetConnectionDTO["mapping"],
        identity: c.identity as SheetConnectionDTO["identity"],
        importMode: c.import_mode as SheetConnectionDTO["importMode"],
        rowsImported: Number(c.rows_imported),
        lastRun: (c.last_run as SheetConnectionDTO["lastRun"]) ?? null,
        createdAt: iso(c.created_at)!,
      })),
      reviewOpen,
    };
  });
}

export async function reviewItems(staff: Staff, status: "open" | "done"): Promise<ReviewItemDTO[]> {
  return asUser(staff.id, async (tx) => {
    const rows = await tx<Row[]>`
      select r.*, c.spreadsheet_name as connection_name, c.sheet_title as connection_tab
      from public.review_items r left join public.sheet_connections c on c.id = r.connection_id
      where ${status === "open" ? tx`r.status = 'open'` : tx`r.status <> 'open'`}
      order by ${status === "open" ? tx`r.created_at asc` : tx`r.resolved_at desc`}
      limit 200`;
    return rows.map((r) => ({
      id: String(r.id),
      connectionId: (r.connection_id as string | null) ?? null,
      connectionName: (r.connection_name as string | null) ?? null,
      connectionTab: (r.connection_tab as string | null) ?? null,
      rowNumber: (r.row_number as number | null) ?? null,
      problems: r.problems as string[],
      raw: r.raw as Record<string, string>,
      parsed: r.parsed as ReviewItemDTO["parsed"],
      status: r.status as ReviewItemDTO["status"],
      resolutionNote: (r.resolution_note as string | null) ?? null,
      resolvedBy: (r.resolved_by as string | null) ?? null,
      resolvedAt: iso(r.resolved_at),
      inquiryId: (r.inquiry_id as string | null) ?? null,
      createdAt: iso(r.created_at)!,
    }));
  });
}

export async function distribution(staff: Staff): Promise<DistributionData> {
  return asUser(staff.id, async (tx) => {
    const [shifts, timeOff, eligibility, rotation] = await Promise.all([
      tx<Row[]>`select * from public.shifts order by weekday, start_minute`,
      tx<Row[]>`select * from public.time_off where ends_on >= (now() at time zone 'Africa/Cairo')::date - 30 order by starts_on`,
      eligibilityRows(tx),
      tx<Row[]>`select * from public.rotation_state`,
    ]);
    return {
      shifts: shifts.map((s) => ({
        id: String(s.id), userId: String(s.user_id), weekday: Number(s.weekday),
        start: hhmm(Number(s.start_minute)), end: hhmm(Number(s.end_minute)), programIds: (s.program_ids as string[]).map(String),
      })),
      timeOff: timeOff.map((t) => ({
        id: String(t.id), userId: String(t.user_id),
        startsOn: new Date(t.starts_on as string).toISOString().slice(0, 10), endsOn: new Date(t.ends_on as string).toISOString().slice(0, 10),
        reason: (t.reason as string | null) ?? null,
      })),
      eligibility,
      rotation: rotation.map((r) => ({ programId: String(r.program_id), lastUserId: (r.last_user_id as string | null) ?? null, lastAssignedAt: iso(r.last_assigned_at) })),
    };
  });
}
