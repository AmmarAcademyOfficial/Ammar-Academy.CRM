"use client";

import { AlertTriangle, CheckCircle2, FileSpreadsheet, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Pill } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { Field, Input, Select } from "@/components/ui/form";
import { Card, EmptyState, PageHeader, SkeletonRows } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import type { ReviewItemDTO } from "@/domain/dto";
import { formatRelative, isValidPhone } from "@/domain/rules";
import { useRunAction } from "@/lib/run-action";
import { useApi, useWorkspace } from "@/lib/workspace";
import { dismissReviewItem, importReviewedRow } from "@/server/sheet-actions";

export function ReviewPage() {
  const [tab, setTab] = useState<"open" | "done">("open");
  const { data, loading } = useApi<ReviewItemDTO[]>(`/api/review?status=${tab}`);
  const [fixing, setFixing] = useState<ReviewItemDTO | null>(null);
  const [dismissing, setDismissing] = useState<ReviewItemDTO | null>(null);

  return (
    <div>
      <PageHeader title="Needs Review" subtitle="Rows from Google Sheets the CRM could not import on its own. Fix and import them, or dismiss them with a reason." />
      <div role="tablist" aria-label="Review items" className="mb-4 flex gap-2">
        {(["open", "done"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={clsx("h-9 rounded-full px-4 text-sm font-medium", tab === t ? "bg-navy-900 text-white" : "border border-line bg-white hover:bg-navy-50")}>
            {t === "open" ? "To review" : "Handled"}
          </button>
        ))}
      </div>
      {loading && !data && <Card><SkeletonRows rows={3} /></Card>}
      {data && data.length === 0 && (
        <Card>
          <EmptyState icon={<CheckCircle2 size={22} />} title={tab === "open" ? "Nothing needs review" : "Nothing handled yet"}>
            {tab === "open" ? "Every sheet row was imported automatically." : null}
          </EmptyState>
        </Card>
      )}
      <div className="space-y-3">
        {data?.map((it) => <ReviewCard key={it.id} item={it} onFix={() => setFixing(it)} onDismiss={() => setDismissing(it)} />)}
      </div>
      {fixing && <FixDialog item={fixing} onClose={() => setFixing(null)} />}
      {dismissing && <DismissDialog item={dismissing} onClose={() => setDismissing(null)} />}
    </div>
  );
}

function ReviewCard({ item, onFix, onDismiss }: { item: ReviewItemDTO; onFix: () => void; onDismiss: () => void }) {
  const { ref, now, openInquiry } = useWorkspace();
  const resolver = ref.profiles.find((p) => p.id === item.resolvedBy)?.fullName;
  return (
    <Card as="article" className="p-4">
      <div className="flex flex-wrap items-start gap-3">
        <FileSpreadsheet size={18} className="mt-0.5 text-ok" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            <bdi>{item.connectionName ?? "Removed connection"}</bdi>
            {item.connectionTab && <> · <bdi>{item.connectionTab}</bdi></>}
            {item.rowNumber ? ` · row ${item.rowNumber}` : ""}
          </p>
          <p className="text-xs text-muted">Found {formatRelative(item.createdAt, now)}</p>
        </div>
        {item.status === "imported" && <Pill className="bg-ok-bg text-ok" icon={<CheckCircle2 size={12} aria-hidden />}>Imported</Pill>}
        {item.status === "dismissed" && <Pill className="bg-[#eeeff3] text-[#4b4e66]" icon={<XCircle size={12} aria-hidden />}>Dismissed</Pill>}
      </div>
      <ul className="mt-3 space-y-1">
        {item.problems.map((p) => <li key={p} className="flex items-center gap-2 text-sm text-warn"><AlertTriangle size={14} aria-hidden /> {p}</li>)}
      </ul>
      <dl className="mt-3 grid gap-x-4 gap-y-1 rounded-lg bg-canvas px-3 py-2 text-sm sm:grid-cols-2">
        {Object.entries(item.raw).map(([k, v]) => (
          <div key={k} className="flex gap-2"><dt className="shrink-0 text-muted" dir="auto">{k}:</dt><dd className="min-w-0 break-words" dir="auto">{v}</dd></div>
        ))}
        {Object.keys(item.raw).length === 0 && <p className="text-muted">The row was empty in the mapped columns.</p>}
      </dl>
      {item.status === "open" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={onFix}>Fix and import</Button>
          <Button size="sm" onClick={onDismiss}>Dismiss</Button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted">
          {item.status === "imported" ? "Imported" : `Dismissed (${item.resolutionNote})`} by {resolver ?? "a manager"}{item.resolvedAt ? ` ${formatRelative(item.resolvedAt, now)}` : ""}.
          {item.inquiryId && <> <button className="font-medium text-navy-700 underline" onClick={() => openInquiry(item.inquiryId)}>Open the customer</button></>}
        </p>
      )}
    </Card>
  );
}

function FixDialog({ item, onClose }: { item: ReviewItemDTO; onClose: () => void }) {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const programs = ref.programs.filter((p) => p.active);
  const [form, setForm] = useState({
    name: item.parsed.name ?? "",
    phone: item.parsed.phone_normalized || item.parsed.phone || "",
    programId: item.parsed.program_id && programs.some((p) => p.id === item.parsed.program_id) ? item.parsed.program_id : programs[0]?.id ?? "",
    studentName: item.parsed.student_name ?? "",
    contactType: (item.parsed.contact_type as "student" | "parent" | "other") ?? "student",
  });
  const [busy, setBusy] = useState(false);
  const phoneError = form.phone && !isValidPhone(form.phone) ? "Enter a valid phone number." : undefined;
  const submit = async () => {
    setBusy(true);
    const r = await runAction(importReviewedRow(item.id, form), null);
    setBusy(false);
    if (r.ok) {
      runAction(Promise.resolve({ ok: true as const, value: null }), r.value.outcome === "resubmitted"
        ? "This person already had an open inquiry; the submission was logged there."
        : "Imported. The lead was assigned to the agent on shift, or waits in the queue.");
      onClose();
    }
  };
  return (
    <Dialog open onClose={onClose} title="Fix and import" description="Correct the values, then import. The lead is assigned like any new lead."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !form.name.trim() || !form.phone.trim() || Boolean(phoneError)} onClick={submit}>{busy ? "Importing…" : "Import lead"}</Button></>}>
      <div className="space-y-4">
        <Field label="Name" required>{(p) => <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} {...p} />}</Field>
        <Field label="Phone" required error={phoneError}>{(p) => <Input dir="ltr" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} {...p} />}</Field>
        <Field label="Program" required>
          {(p) => <Select value={form.programId} onChange={(e) => setForm({ ...form, programId: e.target.value })} {...p}>{programs.map((pr) => <option key={pr.id} value={pr.id}>{pr.code} · {pr.name}</option>)}</Select>}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Filled in by">
            {(p) => (
              <Select value={form.contactType} onChange={(e) => setForm({ ...form, contactType: e.target.value as typeof form.contactType })} {...p}>
                <option value="student">Student</option><option value="parent">Parent</option><option value="other">Other</option>
              </Select>
            )}
          </Field>
          <Field label="Student name">{(p) => <Input value={form.studentName} onChange={(e) => setForm({ ...form, studentName: e.target.value })} {...p} />}</Field>
        </div>
      </div>
    </Dialog>
  );
}

function DismissDialog({ item, onClose }: { item: ReviewItemDTO; onClose: () => void }) {
  const runAction = useRunAction();
  const [note, setNote] = useState("");
  const quick = ["Test entry", "Spam", "Duplicate of an existing customer", "Not interested"];
  return (
    <Dialog open onClose={onClose} title="Dismiss this row?" description="It will not be imported. The reason is kept for the record."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!note.trim()} onClick={async () => { const r = await runAction(dismissReviewItem(item.id, note), "Row dismissed"); if (r.ok) onClose(); }}>Dismiss</Button></>}>
      <div className="mb-3 flex flex-wrap gap-2">
        {quick.map((q) => <Button key={q} size="sm" onClick={() => setNote(q)}>{q}</Button>)}
      </div>
      <Field label="Reason" required>{(p) => <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} {...p} />}</Field>
      <p className="mt-3 text-xs text-muted">Sheet rows are never re-imported once handled. <Link href="/settings/sheets" className="underline">Sheet connections</Link></p>
    </Dialog>
  );
}
