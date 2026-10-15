"use client";

import {
  AlertTriangle, CheckCircle2, CircleSlash, FileSpreadsheet, Link2, Loader2, Pause, Pencil, Play, Plus, RefreshCw, ShieldCheck, Trash2, Unplug,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Pill } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { Field, Select } from "@/components/ui/form";
import { Card, CardHeader, EmptyState, PhoneText, SkeletonRows } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import { useToast } from "@/components/ui/toast";
import type { SheetConnectionDTO, SheetsPageData, SheetStatus } from "@/domain/dto";
import { formatCairo, formatRelative } from "@/domain/rules";
import { SYSTEM_TARGET_LABEL, mappingProblems, type ColumnMapping, type RowIdentity, type SuggestedColumn, type SystemTarget } from "@/domain/sheet-mapping";
import { pickSpreadsheet } from "@/lib/google-picker";
import { useRunAction } from "@/lib/run-action";
import { useApi, useWorkspace } from "@/lib/workspace";
import {
  analyzeSheetTab, createSheetConnection, disconnectGoogle, inspectSpreadsheet, removeSheetConnection, setSheetPaused, syncSheetNow, updateSheetMapping,
} from "@/server/sheet-actions";
import type { PreviewRow, TabAnalysis } from "@/server/sheets/inspect";

/** Server route that starts Google sign-in (needs a full page load, not client navigation). */
const GOOGLE_CONNECT_URL = "/api/google/connect";

type PickedFile = { id: string; title: string; tabs: { gid: number; title: string; rows: number }[] };
type PickerResponse = { mode: "fake"; files: { id: string; name: string }[] } | { mode: "real"; connected: boolean; accessToken?: string; apiKey?: string; appId?: string } | { mode: "off" };

const GOOGLE_RESULT: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Google account connected. Now choose the lead sheet." },
  cancelled: { ok: false, text: "Google sign-in was cancelled. Nothing was connected." },
  expired: { ok: false, text: "The sign-in took too long or was opened in another tab. Please try again." },
  refused: { ok: false, text: "Google did not give access. On Google's screen, keep the box that lets the CRM open the files you pick ticked." },
  failed: { ok: false, text: "Connecting to Google failed. Please try again in a minute." },
  forbidden: { ok: false, text: "Only managers can connect Google Sheets." },
  not_configured: { ok: false, text: "Google Sheets is not set up on this server yet. See the setup guide (docs/GOOGLE_SHEETS_CONNECTION.md)." },
};

export function SheetsSettings() {
  const { data, loading } = useApi<SheetsPageData>("/api/sheets");
  const toast = useToast();
  const runAction = useRunAction();
  const router = useRouter();
  const params = useSearchParams();
  const [fakeFiles, setFakeFiles] = useState<{ id: string; name: string }[] | null>(null);
  const [wizard, setWizard] = useState<{ file: PickedFile } | { edit: SheetConnectionDTO } | null>(null);
  const [opening, setOpening] = useState(false);
  const handled = useRef(false);

  const account = data?.accounts.find((a) => a.status === "connected") ?? null;
  const needsReconnect = data?.accounts.find((a) => a.status === "reconnect") ?? null;

  const onPicked = async (id: string) => {
    const r = await runAction(inspectSpreadsheet(id), null, { quiet: true });
    setOpening(false);
    if (r.ok) setWizard({ file: r.value });
  };

  const openPicker = async () => {
    setOpening(true);
    try {
      const res = await fetch("/api/google/picker", { cache: "no-store" });
      const cfg = (await res.json()) as PickerResponse & { error?: string };
      if (!res.ok) throw new Error(cfg.error ?? "Could not open the file picker.");
      if (cfg.mode === "fake") {
        setFakeFiles(cfg.files);
        setOpening(false);
      } else if (cfg.mode === "real" && cfg.connected && cfg.accessToken && cfg.apiKey && cfg.appId) {
        const picked = await pickSpreadsheet({ accessToken: cfg.accessToken, apiKey: cfg.apiKey, appId: cfg.appId });
        if (picked) await onPicked(picked.id);
        else setOpening(false);
      } else if (cfg.mode === "real") {
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- server route, needs a full page load
        window.location.assign(GOOGLE_CONNECT_URL);
      } else {
        toast.error(GOOGLE_RESULT.not_configured.text);
        setOpening(false);
      }
    } catch (e) {
      toast.error((e as Error).message);
      setOpening(false);
    }
  };

  const startConnect = () => {
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- server route to Google's sign-in, then back here
    if (!account) window.location.assign(GOOGLE_CONNECT_URL);
    else void openPicker();
  };

  // Back from Google's sign-in: say what happened, and go straight on to picking the sheet.
  useEffect(() => {
    const result = params.get("google");
    if (!result || handled.current) return;
    handled.current = true;
    const msg = GOOGLE_RESULT[result] ?? GOOGLE_RESULT.failed;
    if (msg.ok) toast.success(msg.text);
    else toast.error(msg.text);
    router.replace("/settings/sheets");
    // Opened from a timer callback so the picker starts after this render settles.
    if (result === "connected") setTimeout(() => void openPicker(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  if (loading && !data) return <Card><SkeletonRows rows={3} /></Card>;
  if (!data) return null;

  return (
    <div className="space-y-5">
      {needsReconnect && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-bad/40 bg-bad-bg p-4 text-sm">
          <AlertTriangle size={18} className="text-bad" aria-hidden />
          <div className="mr-auto">
            <p className="font-semibold text-bad">Google Sheets stopped syncing</p>
            <p className="text-ink">The Google sign-in for <span dir="ltr">{needsReconnect.email}</span> needs to be reconnected. Your column matching is kept.</p>
          </div>
          <a href="/api/google/connect"><Button variant="navy" icon={<Link2 size={14} />}>Reconnect Google</Button></a>
        </div>
      )}

      <Card>
        <CardHeader
          title="Google Sheets connections"
          subtitle="New rows are imported automatically every 2 minutes and assigned to the sales agent on shift."
          action={data.mode !== "off" && (
            <Button variant="primary" className="whitespace-nowrap" aria-label="Connect Google Sheet" icon={opening ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} disabled={opening} onClick={startConnect}>
              <span className="sm:hidden">Connect</span><span className="hidden sm:inline">Connect Google Sheet</span>
            </Button>
          )}
        />
        {data.mode === "off" && (
          <p className="px-4 py-4 text-sm text-muted">Google Sheets is not set up on this server yet. The one-time Google setup is described in <code>docs/GOOGLE_SHEETS_CONNECTION.md</code>.</p>
        )}
        {data.mode !== "off" && data.connections.length === 0 && (
          <EmptyState icon={<FileSpreadsheet size={22} />} title="No sheets connected yet">
            <ol className="mx-auto mt-2 max-w-md list-decimal space-y-1 pl-5 text-left text-sm text-muted">
              <li>Click <b className="text-ink">Connect Google Sheet</b> and sign in with the Academy Google account.</li>
              <li>Choose the lead sheet in Google&apos;s file picker.</li>
              <li>Check the column matching and the preview, then start syncing.</li>
            </ol>
          </EmptyState>
        )}
        <ul className="divide-y divide-line">
          {data.connections.map((c) => (
            <ConnectionRow key={c.id} c={c} onEdit={() => setWizard({ edit: c })} />
          ))}
        </ul>
      </Card>

      {account && (
        <Card className="flex flex-wrap items-center gap-3 p-4 text-sm">
          <ShieldCheck size={18} className="text-ok" aria-hidden />
          <div className="mr-auto">
            <p>Connected Google account: <b dir="ltr">{account.email}</b></p>
            <p className="text-xs text-muted">The CRM can open only the sheets you pick, read-only. It never edits your sheets. Since {formatCairo(account.connectedAt, "date")}.</p>
          </div>
          <Button size="sm" variant="danger" icon={<Unplug size={14} />} onClick={() => runAction(disconnectGoogle(account.id), "Google account disconnected. Syncing stopped.")}>
            Disconnect
          </Button>
        </Card>
      )}
      {data.mode === "fake" && (
        <p className="text-xs text-muted">Local review mode: Google is simulated with fictional sheets. No real Google account is used.</p>
      )}
      {data.reviewOpen > 0 && (
        <p className="text-sm"><Link href="/review" className="font-medium text-navy-700 underline">{data.reviewOpen} row{data.reviewOpen === 1 ? "" : "s"} need review</Link> — rows the CRM could not import on its own.</p>
      )}

      {fakeFiles && (
        <FakePicker
          files={fakeFiles}
          onClose={() => setFakeFiles(null)}
          onPick={(id) => {
            setFakeFiles(null);
            setOpening(true);
            void onPicked(id);
          }}
        />
      )}
      {wizard && <ConnectWizard key={"file" in wizard ? wizard.file.id : wizard.edit.id} {...wizard} onClose={() => setWizard(null)} />}
    </div>
  );
}

// ── Connection row ───────────────────────────────────────────────────────

const STATUS: Record<SheetStatus, { label: string; cls: string; icon: React.ReactNode }> = {
  active: { label: "Syncing", cls: "bg-ok-bg text-ok", icon: <CheckCircle2 size={12} aria-hidden /> },
  paused: { label: "Paused", cls: "bg-[#eeeff3] text-[#4b4e66]", icon: <Pause size={12} aria-hidden /> },
  needs_attention: { label: "Needs attention", cls: "bg-warn-bg text-warn", icon: <AlertTriangle size={12} aria-hidden /> },
  reconnect: { label: "Reconnect Google", cls: "bg-bad-bg text-bad", icon: <Link2 size={12} aria-hidden /> },
  unavailable: { label: "Sheet unavailable", cls: "bg-bad-bg text-bad", icon: <CircleSlash size={12} aria-hidden /> },
};

export function SheetStatusPill({ status }: { status: SheetStatus }) {
  const s = STATUS[status];
  return <Pill className={s.cls} icon={s.icon}>{s.label}</Pill>;
}

function ConnectionRow({ c, onEdit }: { c: SheetConnectionDTO; onEdit: () => void }) {
  const { ref, now } = useWorkspace();
  const runAction = useRunAction();
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const program = ref.programs.find((p) => p.id === c.programId);

  const syncNow = async () => {
    setBusy(true);
    const r = await runAction(syncSheetNow(c.id), null);
    setBusy(false);
    if (r.ok) {
      const v = r.value;
      runAction(Promise.resolve({ ok: true as const, value: null }), v.status === "active"
        ? `Checked. ${v.imported} new lead${v.imported === 1 ? "" : "s"}${v.resubmitted ? `, ${v.resubmitted} submitted again` : ""}${v.review ? `, ${v.review} sent to Needs Review` : ""}.`
        : v.message ?? "Checked.");
    }
  };

  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-start gap-3">
        <FileSpreadsheet size={20} className="mt-0.5 text-ok" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium" dir="auto">{c.name}</p>
          <p className="text-xs text-muted">Tab “<bdi>{c.tab}</bdi>” · Program {program?.code ?? "—"} · {c.importMode === "all" ? "Imported earlier rows too" : "New rows only"}</p>
        </div>
        <SheetStatusPill status={c.status} />
      </div>
      {c.statusMessage && (
        <p className={clsx("mt-2 rounded-lg px-3 py-2 text-sm", c.status === "active" ? "bg-navy-50 text-ink" : "bg-warn-bg text-warn")}>{c.statusMessage}</p>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div><dt className="text-muted">Last checked</dt><dd>{c.lastCheckedAt ? formatRelative(c.lastCheckedAt, now) : "Not yet"}</dd></div>
        <div><dt className="text-muted">Last successful sync</dt><dd>{c.lastSuccessAt ? formatRelative(c.lastSuccessAt, now) : "Not yet"}</dd></div>
        <div><dt className="text-muted">Leads imported</dt><dd className="tabular-nums">{c.rowsImported}</dd></div>
        <div><dt className="text-muted">Last run</dt><dd>{c.lastRun ? `${c.lastRun.imported} new · ${c.lastRun.resubmitted} again · ${c.lastRun.review} review` : "—"}</dd></div>
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" icon={<RefreshCw size={14} className={busy ? "animate-spin" : ""} />} disabled={busy || c.status === "paused"} onClick={syncNow}>Sync now</Button>
        <Button size="sm" icon={<Pencil size={14} />} onClick={onEdit}>Edit column matching</Button>
        {c.status === "paused"
          ? <Button size="sm" icon={<Play size={14} />} onClick={() => runAction(setSheetPaused(c.id, false), "Syncing resumed")}>Resume</Button>
          : <Button size="sm" icon={<Pause size={14} />} onClick={() => runAction(setSheetPaused(c.id, true), "Syncing paused. Rows added meanwhile are imported when you resume.")}>Pause</Button>}
        <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => setConfirmRemove(true)}>Remove</Button>
      </div>
      {confirmRemove && (
        <Dialog
          open
          onClose={() => setConfirmRemove(false)}
          title="Remove this connection?"
          description="Syncing stops. Leads already imported stay in the CRM exactly as they are. The Google Sheet itself is not changed."
          footer={<><Button onClick={() => setConfirmRemove(false)}>Keep it</Button><Button variant="danger" onClick={async () => { const r = await runAction(removeSheetConnection(c.id), "Connection removed"); if (r.ok) setConfirmRemove(false); }}>Remove connection</Button></>}
        >
          <p className="text-sm" dir="auto">{c.name} · {c.tab}</p>
        </Dialog>
      )}
    </li>
  );
}

// ── Simulated picker (local review only) ─────────────────────────────────

function FakePicker({ files, onPick, onClose }: { files: { id: string; name: string }[]; onPick: (id: string) => void; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title="Choose the lead sheet" description="Simulated Google file picker (local review). In production this is Google's own picker.">
      <ul className="divide-y divide-line rounded-lg border border-line">
        {files.map((f) => (
          <li key={f.id}>
            <button className="flex w-full items-center gap-3 px-3 py-3 text-left text-sm hover:bg-navy-50" onClick={() => onPick(f.id)}>
              <FileSpreadsheet size={18} className="text-ok" aria-hidden />
              <span dir="auto">{f.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

// ── Connect / edit wizard ────────────────────────────────────────────────

const PREVIEW_STATUS: Record<PreviewRow["status"], { label: string; cls: string }> = {
  new: { label: "New lead", cls: "bg-info-bg text-info" },
  existing_customer: { label: "Existing customer · new inquiry", cls: "bg-[#efe8fb] text-[#5b3696]" },
  resubmission: { label: "Submitted again · logged on open inquiry", cls: "bg-navy-100 text-navy-800" },
  review: { label: "Needs review", cls: "bg-warn-bg text-warn" },
};

const IDENTITY_LABEL: Record<RowIdentity, string> = {
  timestamp_phone: "Submission time + phone (recommended for Google Forms)",
  lead_id: "Lead ID column",
  phone_program: "Phone + program (for sheets without a time column)",
};

type WizardProps = ({ file: PickedFile } | { edit: SheetConnectionDTO }) & { onClose: () => void };

function guessProgram(title: string, programs: { id: string; code: string }[]): string {
  const t = title.toLowerCase();
  return (programs.find((p) => t.includes(p.code.toLowerCase())) ?? programs[0])?.id ?? "";
}

function ConnectWizard(props: WizardProps) {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const editing = "edit" in props ? props.edit : null;
  const file = "file" in props ? props.file : null;
  const programs = ref.programs.filter((p) => p.active);
  const firstTab = file?.tabs[0];

  const [step, setStep] = useState<"tab" | "map" | "start">(editing ? "map" : "tab");
  const [gid, setGid] = useState<number>(editing?.sheetGid ?? firstTab?.gid ?? 0);
  const [programId, setProgramId] = useState(editing?.programId ?? guessProgram(`${file?.title ?? ""}`, programs));
  const [analysis, setAnalysis] = useState<TabAnalysis | null>(null);
  const [mapping, setMapping] = useState<SuggestedColumn[]>([]);
  const [identity, setIdentity] = useState<RowIdentity>(editing?.identity ?? "timestamp_phone");
  const [importMode, setImportMode] = useState<"all" | "new_only">("new_only");
  const [busy, setBusy] = useState(false);
  const spreadsheetId = editing?.spreadsheetId ?? file!.id;

  const analyze = async (opts: { mapping?: ColumnMapping[]; identity?: RowIdentity; programId?: string; gid?: number } = {}) => {
    const r = await runAction(analyzeSheetTab({
      spreadsheetId, gid: opts.gid ?? gid, programId: opts.programId ?? programId,
      headerRow: analysis?.headerRow ?? editing?.headerRow, mapping: opts.mapping, identity: opts.identity,
    }), null, { quiet: true });
    if (r.ok) {
      setAnalysis(r.value);
      setMapping(r.value.mapping);
      setIdentity(r.value.identity);
    }
    return r.ok;
  };

  // Editing: load the sheet with the saved matching once.
  const loaded = useRef(false);
  useEffect(() => {
    if (!editing || loaded.current) return;
    loaded.current = true;
    void analyze({ mapping: editing.mapping as ColumnMapping[], identity: editing.identity });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const next = async () => {
    setBusy(true);
    const ok = await analyze({});
    setBusy(false);
    if (ok) setStep("map");
  };

  const changeTarget = (column: number, target: string) => {
    const nextMapping = mapping.map((m) => (m.column === column ? { ...m, target: target as SuggestedColumn["target"], confidence: "sure" as const } : m));
    setMapping(nextMapping);
    void analyze({ mapping: nextMapping, identity });
  };

  const problems = analysis ? mappingProblems(mapping, identity) : [];
  const finish = async () => {
    if (!analysis) return;
    setBusy(true);
    if (editing) {
      const r = await runAction(updateSheetMapping(editing.id, { programId, headerRow: analysis.headerRow, mapping, identity }), "Column matching saved. Syncing continues.");
      setBusy(false);
      if (r.ok) props.onClose();
      return;
    }
    const r = await runAction(createSheetConnection({ spreadsheetId, gid, programId, headerRow: analysis.headerRow, mapping, identity, importMode }), null);
    setBusy(false);
    if (r.ok) {
      const run = r.value.firstRun;
      runAction(Promise.resolve({ ok: true as const, value: null }), importMode === "new_only"
        ? "Connected. New rows will arrive automatically every 2 minutes."
        : `Connected. ${run?.imported ?? 0} lead${run?.imported === 1 ? "" : "s"} imported${run?.review ? `, ${run.review} sent to Needs Review` : ""}${run?.remaining ? `; ${run.remaining} more continue automatically` : ""}.`);
      props.onClose();
    }
  };

  const title = editing ? `Column matching · ${editing.name}` : file ? `Connect “${file.title}”` : "Connect sheet";
  const footer = (
    <>
      <Button onClick={props.onClose}>Cancel</Button>
      {step === "tab" && <Button variant="primary" disabled={busy || !programId} onClick={next}>{busy ? "Reading the sheet…" : "Next: check columns"}</Button>}
      {step === "map" && !editing && <Button variant="primary" disabled={!analysis || problems.length > 0} onClick={() => setStep("start")}>Next: start syncing</Button>}
      {step === "map" && editing && <Button variant="primary" disabled={busy || !analysis || problems.length > 0} onClick={finish}>Save matching</Button>}
      {step === "start" && (
        <>
          <Button onClick={() => setStep("map")}>Back</Button>
          <Button variant="primary" disabled={busy} onClick={finish}>{busy ? "Connecting…" : "Start syncing"}</Button>
        </>
      )}
    </>
  );

  return (
    <Dialog open onClose={props.onClose} title={title} description={step === "tab" ? "Step 1 of 3 · Choose the tab and program" : step === "map" ? (editing ? "Check how columns become CRM fields" : "Step 2 of 3 · Check the columns and preview") : "Step 3 of 3 · Start syncing"} className="max-w-3xl" footer={footer}>
      {step === "tab" && file && (
        <div className="space-y-4">
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium">Which tab holds the leads?</legend>
            <div className="space-y-2">
              {file.tabs.map((t) => (
                <label key={t.gid} className={clsx("flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm", gid === t.gid ? "border-navy-900 bg-navy-50" : "border-line")}>
                  <input type="radio" name="tab" checked={gid === t.gid} onChange={() => setGid(t.gid)} className="accent-navy-900" />
                  <span dir="auto" className="font-medium">{t.title}</span>
                  <span className="ml-auto text-xs text-muted">{Math.max(t.rows - 1, 0)} rows</span>
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Program for this sheet" hint="Used for every row, unless the sheet has a column that says the program.">
            {(p) => (
              <Select value={programId} onChange={(e) => setProgramId(e.target.value)} {...p}>
                {programs.map((pr) => <option key={pr.id} value={pr.id}>{pr.code} · {pr.name}</option>)}
              </Select>
            )}
          </Field>
        </div>
      )}

      {step === "map" && !analysis && <SkeletonRows rows={4} />}
      {step === "map" && analysis && (
        <div className="space-y-5">
          {editing && (
            <Field label="Program for this sheet">
              {(p) => (
                <Select value={programId} onChange={(e) => { setProgramId(e.target.value); void analyze({ mapping, identity, programId: e.target.value }); }} {...p}>
                  {programs.map((pr) => <option key={pr.id} value={pr.id}>{pr.code} · {pr.name}</option>)}
                </Select>
              )}
            </Field>
          )}
          <MappingTable analysis={analysis} mapping={mapping} onChange={changeTarget} />
          {problems.length > 0 && (
            <ul role="alert" className="space-y-1 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">
              {problems.map((p) => <li key={p} className="flex items-center gap-2"><AlertTriangle size={14} aria-hidden /> {p}</li>)}
            </ul>
          )}
          <details className="rounded-lg border border-line px-3 py-2 text-sm">
            <summary className="cursor-pointer font-medium">How rows are recognised: {IDENTITY_LABEL[identity]}</summary>
            <p className="mt-2 text-muted">The CRM remembers each row it has seen, so a row is never imported twice, even if the sheet is re-sorted or rows are inserted. It does not use row numbers.</p>
            <Select aria-label="How rows are recognised" className="mt-2" value={identity} onChange={(e) => { const v = e.target.value as RowIdentity; setIdentity(v); void analyze({ mapping, identity: v }); }}>
              {(Object.keys(IDENTITY_LABEL) as RowIdentity[]).map((k) => <option key={k} value={k}>{IDENTITY_LABEL[k]}</option>)}
            </Select>
          </details>
          <PreviewList analysis={analysis} />
        </div>
      )}

      {step === "start" && analysis && (
        <div className="space-y-4">
          <p className="text-sm">The sheet has <b>{analysis.counts.rows}</b> row{analysis.counts.rows === 1 ? "" : "s"} today. What should happen to them?</p>
          <fieldset className="space-y-2">
            <legend className="sr-only">Rows already in the sheet</legend>
            {([
              ["new_only", "Only rows added from now on", "Recommended when these leads were already handled outside the CRM. Existing rows are remembered and skipped."],
              ["all", "Import existing rows too", importSummary(analysis.counts)],
            ] as const).map(([value, label, hint]) => (
              <label key={value} className={clsx("flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 text-sm", importMode === value ? "border-navy-900 bg-navy-50" : "border-line")}>
                <input type="radio" name="mode" className="mt-0.5 accent-navy-900" checked={importMode === value} onChange={() => setImportMode(value)} />
                <span><span className="font-medium">{label}</span><span className="block text-xs text-muted">{hint}</span></span>
              </label>
            ))}
          </fieldset>
          <p className="flex items-center gap-2 text-xs text-muted"><RefreshCw size={12} aria-hidden /> After this, the CRM checks the sheet every 2 minutes. The sheet is never edited.</p>
        </div>
      )}
    </Dialog>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "4 new leads, 1 repeat submission logged on its open inquiry, 1 row to Needs Review." */
function importSummary(c: TabAnalysis["counts"]): string {
  const fresh = c.ready - c.existingCustomers - c.resubmissions;
  const parts = [plural(fresh, "new lead", "new leads")];
  if (c.existingCustomers) parts.push(`${plural(c.existingCustomers, "new inquiry", "new inquiries")} for existing customers`);
  if (c.resubmissions) parts.push(`${plural(c.resubmissions, "repeat submission", "repeat submissions")} logged on the open inquiry (no duplicates)`);
  if (c.review) parts.push(`${plural(c.review, "row", "rows")} to Needs Review`);
  return `${parts.join(", ")}. New leads are assigned to the agents on shift.`;
}

function MappingTable({ analysis, mapping, onChange }: { analysis: TabAnalysis; mapping: SuggestedColumn[]; onChange: (column: number, target: string) => void }) {
  const { ref } = useWorkspace();
  const fields = ref.fields.filter((f) => !f.archived);
  const groups: { label: string; targets: [string, string][] }[] = [
    { label: "Contact", targets: (["name", "phone", "phone_secondary", "contact_type", "student_name"] as SystemTarget[]).map((t) => [t, SYSTEM_TARGET_LABEL[t]]) },
    { label: "Inquiry", targets: (["program", "submitted_at", "lead_id"] as SystemTarget[]).map((t) => [t, SYSTEM_TARGET_LABEL[t]]) },
    { label: "Customer fields", targets: fields.map((f) => [`field:${f.id}`, f.label]) },
    { label: "Other", targets: [["note", SYSTEM_TARGET_LABEL.note]] },
  ];
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-sm">
        <caption className="sr-only">Column matching</caption>
        <thead>
          <tr className="border-b border-line bg-canvas text-left text-xs text-muted">
            <th className="px-3 py-2 font-medium">Sheet column</th>
            <th className="px-3 py-2 font-medium">Example</th>
            <th className="px-3 py-2 font-medium">Goes to CRM field</th>
          </tr>
        </thead>
        <tbody>
          {analysis.headers.map((h, col) => {
            const m = mapping.find((x) => x.column === col);
            const target = m?.target ?? "";
            return (
              <tr key={col} className="border-b border-line/70 last:border-0">
                <td className="px-3 py-2 font-medium" dir="auto">{h || <span className="text-muted">Column {col + 1}</span>}</td>
                <td className="max-w-[180px] truncate px-3 py-2 text-muted" dir="auto" title={analysis.samples[col]}>{analysis.samples[col] || "—"}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Select aria-label={`CRM field for column ${h || col + 1}`} className="h-9 min-w-[200px] text-[13px]" value={target} onChange={(e) => onChange(col, e.target.value)}>
                      <option value="">Don&apos;t import this column</option>
                      {groups.map((g) => (
                        <optgroup key={g.label} label={g.label}>
                          {g.targets.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </optgroup>
                      ))}
                    </Select>
                    {target && m?.confidence === "guess" && <Pill className="bg-warn-bg text-warn" icon={<AlertTriangle size={12} aria-hidden />}>Please check</Pill>}
                    {target && m?.confidence === "sure" && <Pill className="bg-ok-bg text-ok" icon={<CheckCircle2 size={12} aria-hidden />}>Matched</Pill>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PreviewList({ analysis }: { analysis: TabAnalysis }) {
  const c = analysis.counts;
  return (
    <section aria-label="Preview">
      <h3 className="text-sm font-semibold">Preview of the first {analysis.preview.length} rows</h3>
      <p className="mb-2 text-xs text-muted">
        {c.rows} rows found · {c.ready} ready ({c.existingCustomers} existing customers, {c.resubmissions} submitted again) · {c.review} need review
      </p>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {analysis.preview.map((r) => (
          <li key={r.rowNumber} className="px-3 py-2.5 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="w-12 text-xs text-muted">Row {r.rowNumber}</span>
              <span className="font-medium" dir="auto">{r.name || <span className="text-muted">No name</span>}</span>
              {r.phone && <PhoneText value={r.phone} className="text-muted" />}
              <span className="text-xs text-muted">{r.program}</span>
              <Pill className={clsx("ml-auto", PREVIEW_STATUS[r.status].cls)}>{PREVIEW_STATUS[r.status].label}</Pill>
            </div>
            {r.problems.length > 0 && <p className="mt-1 pl-12 text-xs text-warn">{r.problems.join(" · ")}</p>}
          </li>
        ))}
        {analysis.preview.length === 0 && <li className="px-3 py-4 text-sm text-muted">No rows yet. New rows will be imported as they arrive.</li>}
      </ul>
    </section>
  );
}
