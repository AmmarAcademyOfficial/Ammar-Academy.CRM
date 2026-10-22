"use client";

import { AlertTriangle, ChevronLeft, ChevronRight, Download, GraduationCap, Lock, LockOpen, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Pill } from "@/components/ui/badges";
import { Button, IconButton } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { Card, CardHeader, EmptyState, SkeletonRows, Stat } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import { academyMonth } from "@/domain/accounting";
import type { SalaryReport, SalaryTeacher } from "@/domain/dto";
import { cairoParts, formatCairo, formatMoney } from "@/domain/rules";
import { hoursText } from "@/features/sessions/session-ui";
import { formatDay } from "@/features/leads/filters";
import { toCsv } from "@/lib/csv";
import { useRunAction } from "@/lib/run-action";
import { useApi, useWorkspace } from "@/lib/workspace";
import { closeSalaryMonth, deleteSalaryAdjustment, reopenSalaryMonth, saveSalaryAdjustment } from "@/server/salary-actions";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
/** "YYYY-MM" shifted by whole months. */
const shiftMonth = (m: string, by: number) => {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
const totalsText = (t: Record<string, number>) => {
  const list = Object.entries(t).sort((a, b) => b[1] - a[1]);
  return list.length ? list.map(([c, a]) => formatMoney(a, c)).join(" · ") : formatMoney(0, "EGP");
};

function download(name: string, rows: unknown[][]) {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Accounting → Teachers: salaries per Academy month (26th–25th) from recorded session hours. */
export function TeachersView() {
  const { me, now } = useWorkspace();
  const today = cairoParts(now).date;
  const current = academyMonth(today).to.slice(0, 7);
  const [month, setMonth] = useState(current);
  const { data, loading, error } = useApi<SalaryReport>(`/api/salaries?month=${month}`);
  const [adding, setAdding] = useState<{ teacherId?: string } | null>(null);
  const [closing, setClosing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const r = data?.month === month ? data : undefined;
  const isManager = me.role === "manager";
  const open = r?.status === "open";
  const hours = r ? r.teachers.flatMap((t) => t.lines).reduce((s, l) => s + l.hours, 0) : 0;

  const exportCsv = () => {
    if (!r) return;
    // Amounts stay positive (a leading minus would be escaped as text by the CSV safety rule); Type says how each line counts.
    const rows: unknown[][] = [["Teacher", "Type", "Line", "Hours", "Sessions", "Per hour", "Currency", "Amount"]];
    for (const t of r.teachers) {
      for (const l of t.lines) rows.push([t.name, "Pay", l.rateName, l.hours, l.sessions, l.perHour ?? "", l.currency, l.amount ?? ""]);
      for (const a of t.adjustments) rows.push([t.name, a.kind === "bonus" ? "Bonus" : "Deduction", a.note, "", "", "", a.currency, a.amount]);
      for (const [c, a] of Object.entries(t.totals)) rows.push([t.name, "Total", "Pay + bonuses − deductions", "", "", "", c, a]);
    }
    download(`salaries-${r.month}.csv`, rows);
  };

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-2 p-3">
        <div className="flex items-center gap-1">
          <IconButton label="Previous month" icon={<ChevronLeft size={16} />} onClick={() => setMonth(shiftMonth(month, -1))} />
          <span className="min-w-[9rem] text-center text-sm font-semibold" data-testid="salary-month">{monthLabel(month)}</span>
          <IconButton label="Next month" icon={<ChevronRight size={16} />} onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= current} />
        </div>
        <span className="text-sm text-muted">{formatDay(`${shiftMonth(month, -1)}-26`)} – {formatDay(`${month}-25`)}</span>
        {r && (open
          ? <Pill className="bg-[#eeeff3] text-[#4b4e66]" icon={<LockOpen size={12} />}>{r.ended ? "Ended · not closed" : "In progress"}</Pill>
          : <Pill className="bg-ok-bg text-ok" icon={<Lock size={12} />}>Closed</Pill>)}
        <div className="flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto">
          {month !== current && <Button size="sm" onClick={() => setMonth(current)}>This month</Button>}
          <Button size="sm" icon={<Download size={14} />} onClick={exportCsv} disabled={!r || r.teachers.length === 0}>Export CSV</Button>
          {r && open && <Button size="sm" icon={<Plus size={14} />} onClick={() => setAdding({})}>Bonus or deduction</Button>}
          {r && isManager && open && r.ended && <Button size="sm" variant="primary" icon={<Lock size={14} />} onClick={() => setClosing(true)}>Close month</Button>}
          {r && isManager && !open && <Button size="sm" icon={<LockOpen size={14} />} onClick={() => setReopening(true)}>Reopen</Button>}
        </div>
      </Card>

      {error && <Card className="p-4 text-sm text-bad">{error}</Card>}
      {!r && loading && <Card><SkeletonRows rows={4} /></Card>}

      {r && (
        <>
          {!open && (
            <Card className="border-ok/30 p-3 text-sm" data-testid="closed-note">
              Closed{r.closedBy ? ` by ${r.closedBy}` : ""}{r.closedAt ? ` on ${formatCairo(r.closedAt)}` : ""}. These figures are frozen: sessions in this month can no longer change.
              {isManager ? " Reopen the month to change anything." : ""}
            </Card>
          )}
          {open && r.reopenReason && <Card className="p-3 text-sm text-muted">Reopened: {r.reopenReason}</Card>}
          {open && r.unrecorded > 0 && (
            <Card className="flex flex-wrap items-center gap-2 border-orange-500/40 p-3 text-sm" data-testid="unrecorded-note">
              <AlertTriangle size={16} className="text-warn" aria-hidden />
              <span>{r.unrecorded} past session{r.unrecorded === 1 ? " is" : "s are"} not recorded yet, so {r.unrecorded === 1 ? "it isn't" : "they aren't"} counted. </span>
              <Link href="/sessions" className="font-medium text-navy-700 hover:underline">Open Sessions</Link>
            </Card>
          )}
          {open && r.missingRates > 0 && (
            <Card className="flex items-center gap-2 border-bad/30 p-3 text-sm text-bad">
              <AlertTriangle size={16} aria-hidden /> Some sessions have no hourly amount for their date. Set it in Settings → Teachers.
            </Card>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat label={open ? "To pay so far" : "To pay"} value={<span data-testid="salary-total">{totalsText(r.totals)}</span>} hint="Pay + bonuses − deductions, per currency" />
            <Stat label="Teachers" value={r.teachers.length} />
            <Stat label="Paid hours" value={hoursText(hours)} />
          </div>

          {r.teachers.length === 0 ? (
            <Card>
              <EmptyState icon={<GraduationCap size={20} />} title="Nothing to pay for this month yet">
                Pay appears here as support records sessions. Bonuses and deductions can be added at any time while the month is open.
              </EmptyState>
            </Card>
          ) : (
            r.teachers.map((t) => <TeacherCard key={t.teacherId} t={t} open={open} onAdd={() => setAdding({ teacherId: t.teacherId })} />)
          )}
        </>
      )}

      {adding && r && <AdjustmentDialog month={month} teacherId={adding.teacherId} report={r} onClose={() => setAdding(null)} />}
      {closing && r && <CloseDialog report={r} onClose={() => setClosing(false)} />}
      {reopening && r && <ReopenDialog month={r.month} onClose={() => setReopening(false)} />}
    </div>
  );
}

function TeacherCard({ t, open, onAdd }: { t: SalaryTeacher; open: boolean; onAdd: () => void }) {
  const runAction = useRunAction();
  const [busy, setBusy] = useState<string | null>(null);
  const remove = async (id: string) => {
    setBusy(id);
    await runAction(deleteSalaryAdjustment(id), "Removed");
    setBusy(null);
  };
  return (
    <Card data-teacher={t.name}>
      <CardHeader title={t.name} subtitle={<span data-testid="teacher-total">{totalsText(t.totals)}</span>}
        action={open ? <Button size="sm" icon={<Plus size={14} />} onClick={onAdd}>Add</Button> : undefined} />
      <ul className="divide-y divide-line text-sm" aria-label={`Pay lines: ${t.name}`}>
        {t.lines.map((l) => (
          <li key={`${l.rateId}-${l.perHour}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2" data-line={l.rateName}>
            <span className="min-w-0 flex-1 font-medium">{l.rateName}</span>
            <span className="tabular-nums text-muted">
              {hoursText(l.hours)} × {l.perHour === null ? <span className="text-bad">no amount set</span> : formatMoney(l.perHour, l.currency)}
              {" · "}{l.sessions} session{l.sessions === 1 ? "" : "s"}
            </span>
            <span className="w-full text-right font-semibold tabular-nums sm:w-32">{l.amount === null ? "—" : formatMoney(l.amount, l.currency)}</span>
          </li>
        ))}
        {t.adjustments.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2" data-adjustment={a.kind}>
            <Pill className={a.kind === "bonus" ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn"}>{a.kind === "bonus" ? "Bonus" : "Deduction"}</Pill>
            <span className="min-w-0 flex-1">{a.note}{a.createdBy && <span className="text-xs text-muted"> · {a.createdBy}</span>}</span>
            <span className="font-semibold tabular-nums sm:w-32 sm:text-right">{a.kind === "bonus" ? "+" : "−"}{formatMoney(a.amount, a.currency)}</span>
            {open && <IconButton label={`Remove ${a.kind}: ${a.note}`} icon={<Trash2 size={14} />} disabled={busy === a.id} onClick={() => remove(a.id)} />}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AdjustmentDialog({ month, teacherId, report, onClose }: { month: string; teacherId?: string; report: SalaryReport; onClose: () => void }) {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const teachers = ref.teachers.filter((t) => t.active || report.teachers.some((r) => r.teacherId === t.id));
  const currencyOf = (id: string) => report.teachers.find((r) => r.teacherId === id)?.lines[0]?.currency ?? "EGP";
  const first = teacherId ?? teachers[0]?.id ?? "";
  const [f, setF] = useState({ teacherId: first, kind: "bonus" as "bonus" | "deduction", amount: "", currency: currencyOf(first), note: "" });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await runAction(saveSalaryAdjustment({ month, teacherId: f.teacherId, kind: f.kind, amount: Number(f.amount), currency: f.currency, note: f.note }),
      f.kind === "bonus" ? "Bonus added" : "Deduction added");
    setBusy(false);
    if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title="Bonus or deduction" description={`${monthLabel(month)} salaries`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !f.teacherId || !(Number(f.amount) > 0) || !f.note.trim()} onClick={save}>{busy ? "Saving…" : "Save"}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Teacher" required className="sm:col-span-2">
          {(p) => <Select value={f.teacherId} onChange={(e) => setF({ ...f, teacherId: e.target.value, currency: currencyOf(e.target.value) })} {...p}>
            {teachers.map((t) => <option key={t.id} value={t.id}>{t.fullName}</option>)}
          </Select>}
        </Field>
        <Field label="Type" required>
          {(p) => <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as "bonus" | "deduction" })} {...p}>
            <option value="bonus">Bonus (adds)</option>
            <option value="deduction">Deduction (subtracts)</option>
          </Select>}
        </Field>
        <div className="grid grid-cols-[1fr_6rem] gap-2">
          <Field label="Amount" required>{(p) => <Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} {...p} />}</Field>
          <Field label="Currency" required>
            {(p) => <Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} {...p}><option>EGP</option><option>USD</option></Select>}
          </Field>
        </div>
        <Field label="Reason" required className="sm:col-span-2">
          {(p) => <Input value={f.note} maxLength={300} placeholder="e.g. Extra mock exam on Friday" onChange={(e) => setF({ ...f, note: e.target.value })} {...p} />}
        </Field>
      </div>
    </Dialog>
  );
}

function CloseDialog({ report, onClose }: { report: SalaryReport; onClose: () => void }) {
  const runAction = useRunAction();
  const [busy, setBusy] = useState(false);
  const blocked = report.unrecorded > 0 || report.missingRates > 0;
  const close = async () => {
    setBusy(true);
    const r = await runAction(closeSalaryMonth(report.month), `${monthLabel(report.month)} closed`);
    setBusy(false);
    if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title={`Close ${monthLabel(report.month)}?`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Lock size={14} />} disabled={busy || blocked} onClick={close}>{busy ? "Closing…" : "Close month"}</Button></>}>
      <div className="space-y-3 text-sm">
        <p>Total to pay: <b className="font-semibold">{totalsText(report.totals)}</b> for {report.teachers.length} teacher{report.teachers.length === 1 ? "" : "s"}.</p>
        <p className="text-muted">Closing freezes these figures. Sessions from {formatDay(report.from)} to {formatDay(report.to)} can then no longer be changed, and bonuses and deductions are locked. You can reopen the month later with a reason.</p>
        {report.unrecorded > 0 && <p className="text-bad">{report.unrecorded} session{report.unrecorded === 1 ? " is" : "s are"} not recorded yet. Record {report.unrecorded === 1 ? "it" : "them"} first.</p>}
      </div>
    </Dialog>
  );
}

function ReopenDialog({ month, onClose }: { month: string; onClose: () => void }) {
  const runAction = useRunAction();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const reopen = async () => {
    setBusy(true);
    const r = await runAction(reopenSalaryMonth(month, reason), `${monthLabel(month)} reopened`);
    setBusy(false);
    if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title={`Reopen ${monthLabel(month)}?`} description="The figures will be worked out from the sessions again, and changes become possible."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !reason.trim()} onClick={reopen}>{busy ? "Reopening…" : "Reopen"}</Button></>}>
      <Field label="Reason" required>{(p) => <Input value={reason} maxLength={300} placeholder="e.g. A session was recorded with the wrong hours" onChange={(e) => setReason(e.target.value)} {...p} />}</Field>
    </Dialog>
  );
}
