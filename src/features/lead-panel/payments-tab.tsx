"use client";

import { CalendarRange, Check, GraduationCap, Info, Loader2, Paperclip, Pencil, Plus, Trash2, Undo2, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { DueBadge, PaymentBadge, SubmissionBadge } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { EmptyState } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import { useToast } from "@/components/ui/toast";
import type { LeadDetail } from "@/domain/dto";
import { cairoParts, formatCairo, formatMoney, handoverCheck } from "@/domain/rules";
import type { PaymentDue, PaymentKind, PaymentMethod, PaymentStatus, PaymentSubmission } from "@/domain/types";
import { CourseTypeChip } from "@/features/settings/courses-settings";
import { KIND_LABEL, METHOD_LABEL, courseFacts, courseOf, courseTypeOf, priceText } from "@/lib/courses";
import { profileName, type LeadRow } from "@/lib/lead-row";
import { useRunAction } from "@/lib/run-action";
import { useWorkspace } from "@/lib/workspace";
import { decidePayment, deletePaymentDue, reversePayment, saveEnrollment, savePaymentDue, submitPayment } from "@/server/payment-actions";

const HANDOVER_TEXT = {
  below_threshold: "Not handed over yet: confirmed payments are below the qualifying deposit.",
  deposit_rule_not_set: "Not handed over yet: this program has no qualifying deposit set, so handover waits for full payment.",
  needs_full_payment: "Not handed over yet: handover waits for full payment.",
} as const;

/**
 * canWork: may change the enrollment (sales owner, managers). canPay: may record payments (also the
 * customer's support owner). canPlan: may change the payment plan (managers, support owner).
 */
export function PaymentsTab({ detail, row, canWork, canPay, canPlan }: { detail: LeadDetail; row: LeadRow; canWork: boolean; canPay: boolean; canPlan: boolean }) {
  const { ref, me } = useWorkspace();
  const [enrolling, setEnrolling] = useState(false);
  const [paying, setPaying] = useState(false);
  const [dueEdit, setDueEdit] = useState<PaymentDue | "new" | null>(null);
  const e = detail.enrollment;
  const t = detail.totals;

  if (!e || !t) {
    return (
      <>
        <EmptyState
          icon={<GraduationCap size={20} />}
          title="No enrollment yet"
          action={canWork && !row.stage.isClosed ? <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEnrolling(true)}>Start enrollment</Button> : undefined}
        >
          When the customer agrees to a course, start the enrollment with the agreed price. Then submit each payment for a manager to confirm.
        </EmptyState>
        {enrolling && <EnrollmentDialog detail={detail} row={row} onClose={() => setEnrolling(false)} />}
      </>
    );
  }

  const course = courseOf(ref, e.courseId);
  const status: PaymentStatus = t.paid <= 0 ? "unpaid" : t.paid >= t.agreed ? "fully_paid" : "partially_paid";
  const check = handoverCheck(ref.settings, row.program.id, { paid: t.paid }, t.agreed);
  const pct = Math.min(100, Math.round((t.paid / t.agreed) * 100));
  const hasConfirmed = detail.payments.some((p) => p.status === "confirmed");
  const canEditEnrollment = canWork && (me.role === "manager" || !hasConfirmed);
  const remaining = Math.max(t.agreed - t.paid - t.pending, 0);

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-line p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-muted">Course</p>
            <p className="font-medium">{course?.name ?? "—"}</p>
            {course && <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted"><CourseTypeChip type={courseTypeOf(ref, course)} /> {courseFacts(course)}</p>}
          </div>
          <div className="flex items-center gap-2">
            <PaymentBadge status={status} />
            {canEditEnrollment && <Button size="sm" icon={<Pencil size={14} />} onClick={() => setEnrolling(true)}>Change</Button>}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
          <div><p className="text-xs text-muted">Agreed total</p><p className="font-semibold tabular-nums">{formatMoney(t.agreed, e.currency)}</p></div>
          <div><p className="text-xs text-muted">Confirmed paid</p><p className="font-semibold tabular-nums text-ok">{formatMoney(t.paid, e.currency)}</p></div>
          <div><p className="text-xs text-muted">Balance left</p><p className="font-semibold tabular-nums" data-testid="balance-left">{formatMoney(t.balance, e.currency)}</p></div>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-navy-50" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Confirmed share of agreed total">
          <div className="h-full rounded-full bg-ok" style={{ width: `${pct}%` }} />
        </div>
        {t.pending > 0 && <p className="mt-2 text-xs font-medium text-warn">{formatMoney(t.pending, e.currency)} waiting for manager review (not counted yet)</p>}
        {e.priceNote && <p className="mt-2 text-xs text-muted">Price note: {e.priceNote}</p>}
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted">
          <Info size={12} className="mt-0.5 shrink-0" aria-hidden />
          {detail.onboarding ? "Handed over to customer support." : check.met ? "Meets the handover rule." : HANDOVER_TEXT[check.reason as keyof typeof HANDOVER_TEXT]}
        </p>
        {e.originalSalesOwnerId && <p className="mt-1 text-xs text-muted">Sold by {profileName(ref, e.originalSalesOwnerId)}</p>}
      </section>

      <PlanSection dues={detail.dues} currency={e.currency} canPlan={canPlan && t.balance > 0} onAdd={() => setDueEdit("new")} onEdit={setDueEdit} />

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Payments</h3>
          {canPay && remaining > 0 && <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setPaying(true)}>Record payment</Button>}
        </div>
        {detail.payments.length === 0 ? (
          <p className="text-sm text-muted">No payments submitted yet.</p>
        ) : (
          <div className="space-y-2">{detail.payments.map((p) => <SubmissionItem key={p.id} p={p} currency={e.currency} />)}</div>
        )}
      </section>

      {enrolling && <EnrollmentDialog detail={detail} row={row} onClose={() => setEnrolling(false)} />}
      {paying && (
        <PaymentDialog enrollmentId={e.id} currency={e.currency} remaining={remaining} canPlan={canPlan}
          firstPayment={!detail.payments.some((p) => p.status === "pending" || p.status === "confirmed")} onClose={() => setPaying(false)} />
      )}
      {dueEdit && <DueDialog enrollmentId={e.id} currency={e.currency} due={dueEdit === "new" ? null : dueEdit} onClose={() => setDueEdit(null)} />}
    </div>
  );
}

// ── One submission, with manager actions ─────────────────────────────────

export function SubmissionItem({ p, currency, customer }: { p: PaymentSubmission; currency: string; customer?: string }) {
  const { ref, me } = useWorkspace();
  const runAction = useRunAction();
  const [mode, setMode] = useState<null | "reject" | "reverse">(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const isManager = me.role === "manager" || me.role === "accountant"; // may decide payments

  const confirm = async () => {
    setBusy(true);
    const r = await runAction(decidePayment(p.id, "confirmed"), null);
    setBusy(false);
    if (r.ok) runAction(Promise.resolve({ ok: true as const, value: null }), r.value.handedOver ? "Payment confirmed. The customer is Enrolled and handed over to support." : "Payment confirmed");
  };
  const finish = async () => {
    setBusy(true);
    const r = mode === "reject"
      ? await runAction(decidePayment(p.id, "rejected", reason), "Payment rejected. The agent was told why.")
      : await runAction(reversePayment(p.id, reason), null);
    setBusy(false);
    if (r.ok) {
      if (mode === "reverse") {
        const flagged = (r.value as { flagged?: boolean }).flagged;
        runAction(Promise.resolve({ ok: true as const, value: null }), flagged ? "Payment reversed. The customer is below the handover rule and was flagged for review." : "Payment reversed. Totals were recalculated.");
      }
      setMode(null);
      setReason("");
    }
  };

  return (
    <article className="rounded-lg border border-line p-3" aria-label={`Payment ${formatMoney(p.amount, currency)}${customer ? ` for ${customer}` : ""}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[15px] font-semibold tabular-nums">{formatMoney(p.amount, currency)}</span>
        {p.kind && <span className="text-xs font-medium text-ink/80" data-kind={p.kind}>{KIND_LABEL[p.kind]}</span>}
        <SubmissionBadge status={p.status} />
        <span className="text-xs text-muted">{METHOD_LABEL[p.method]} · paid {formatCairo(p.paidOn, "date")}{p.reference ? <> · ref <span dir="ltr">{p.reference}</span></> : null}</span>
      </div>
      <p className="mt-1 text-xs text-muted">
        Submitted by {profileName(ref, p.submittedById)} · {formatCairo(p.submittedAt)}
        {p.decidedAt && ` · ${p.status === "reversed" ? "confirmed" : p.status} by ${profileName(ref, p.decidedById)} ${formatCairo(p.decidedAt)}`}
        {p.reversedAt && ` · reversed by ${profileName(ref, p.reversedById)} ${formatCairo(p.reversedAt)}`}
      </p>
      {p.hasReceipt && (
        <a href={`/api/receipts/${p.id}`} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-navy-700 hover:underline">
          <Paperclip size={12} aria-hidden /> {p.receiptName ?? "Receipt"}
        </a>
      )}
      {p.note && <p dir="auto" className="mt-1 text-sm">{p.note}</p>}
      {p.decisionReason && <p className="mt-1 text-sm text-bad">Reason: {p.decisionReason}</p>}
      {p.reversalReason && <p className="mt-1 text-sm text-bad">Reversed: {p.reversalReason}</p>}
      {isManager && p.status === "pending" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="navy" icon={<Check size={14} />} disabled={busy} onClick={confirm}>Confirm</Button>
          <Button size="sm" variant="danger" icon={<X size={14} />} disabled={busy} onClick={() => setMode("reject")}>Reject</Button>
        </div>
      )}
      {isManager && p.status === "confirmed" && (
        <button className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-bad" onClick={() => setMode("reverse")}>
          <Undo2 size={12} aria-hidden /> Reverse
        </button>
      )}
      {mode && (
        <Dialog
          open
          onClose={() => setMode(null)}
          title={mode === "reject" ? "Reject payment" : "Reverse confirmed payment"}
          description={mode === "reject" ? "The agent is notified with your reason." : "Totals are recalculated. If the customer was handed over and drops below the rule, the support record is kept and flagged for review."}
          footer={<><Button onClick={() => setMode(null)}>Cancel</Button><Button variant="danger" disabled={busy || !reason.trim()} onClick={finish}>{mode === "reject" ? "Reject" : "Reverse"}</Button></>}
        >
          <Field label="Reason" required>
            {(f) => <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder={mode === "reject" ? "e.g. Reference not found in the bank statement" : "e.g. Bank returned the transfer"} {...f} />}
          </Field>
        </Dialog>
      )}
    </article>
  );
}

// ── Enrollment ───────────────────────────────────────────────────────────

function EnrollmentDialog({ detail, row, onClose }: { detail: LeadDetail; row: LeadRow; onClose: () => void }) {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const e = detail.enrollment;
  const options = ref.courses.filter((c) => c.programId === row.program.id && (c.active || c.id === e?.courseId));
  const initialCourse = e?.courseId ?? (row.inquiry.courseId && options.some((c) => c.id === row.inquiry.courseId) ? row.inquiry.courseId : options[0]?.id ?? "");
  const [courseId, setCourseId] = useState(initialCourse);
  const course = options.find((c) => c.id === courseId);
  const [total, setTotal] = useState(e ? String(e.agreedTotal) : course?.price ? String(course.price) : "");
  const [note, setNote] = useState(e?.priceNote ?? "");
  const [busy, setBusy] = useState(false);
  const differs = course?.price !== null && course?.price !== undefined && Number(total) !== course.price;

  const pickCourse = (id: string) => {
    setCourseId(id);
    const c = options.find((x) => x.id === id);
    if (!e && c?.price) setTotal(String(c.price));
  };
  const save = async () => {
    setBusy(true);
    const r = await runAction(saveEnrollment({ inquiryId: row.inquiry.id, courseId, agreedTotal: Number(total), priceNote: note || undefined }), e ? "Enrollment updated" : "Enrollment started. The lead is now Awaiting Payment.");
    setBusy(false);
    if (r.ok) onClose();
  };

  return (
    <Dialog open onClose={onClose} title={e ? "Change enrollment" : "Start enrollment"} description="The agreed total is what the customer will pay for this course."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !courseId || !(Number(total) > 0) || (differs && !note.trim())} onClick={save}>{busy ? "Saving…" : "Save"}</Button></>}>
      {options.length === 0 ? (
        <p className="text-sm text-muted">There are no open courses for {row.program.code}. A manager adds them in Settings → Courses and Prices.</p>
      ) : (
        <div className="space-y-4">
          <Field label="Course" required>
            {(p) => <Select value={courseId} onChange={(ev) => pickCourse(ev.target.value)} {...p}>{options.map((c) => <option key={c.id} value={c.id}>{c.name} · {priceText(c)}</option>)}</Select>}
          </Field>
          {course && (
            <div className="rounded-lg bg-canvas p-3 text-xs text-muted">
              <p className="flex flex-wrap items-center gap-2"><CourseTypeChip type={courseTypeOf(ref, course)} /> {courseFacts(course)}</p>
              {course.description && <p className="mt-1 text-ink/80" dir="auto">{course.description}</p>}
            </div>
          )}
          <Field label={`Agreed total (${course?.currency ?? "EGP"})`} required hint={course?.price ? `Course price ${priceText(course)}` : "This course has no fixed price."}>
            {(p) => <Input inputMode="decimal" value={total} onChange={(ev) => setTotal(ev.target.value)} {...p} />}
          </Field>
          {(differs || note) && (
            <Field label="Reason for the different price" required={differs}>
              {(p) => <Input value={note} maxLength={300} onChange={(ev) => setNote(ev.target.value)} placeholder="e.g. Sibling discount, early-bird offer" {...p} />}
            </Field>
          )}
        </div>
      )}
    </Dialog>
  );
}

// ── Payment plan ─────────────────────────────────────────────────────────

function PlanSection({ dues, currency, canPlan, onAdd, onEdit }: { dues: PaymentDue[]; currency: string; canPlan: boolean; onAdd: () => void; onEdit: (d: PaymentDue) => void }) {
  const runAction = useRunAction();
  if (dues.length === 0 && !canPlan) return null;
  return (
    <section aria-label="Payment plan">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Payment plan</h3>
        {canPlan && <Button size="sm" icon={<CalendarRange size={14} />} onClick={onAdd}>Add expected payment</Button>}
      </div>
      {dues.length === 0 ? (
        <p className="text-sm text-muted">No payments planned. Add the next payment date so you are reminded before it is due.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {dues.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm" data-due={d.status}>
              <span className="w-28 shrink-0 font-medium">{formatCairo(d.dueOn, "date")}</span>
              <span className="font-semibold tabular-nums">{formatMoney(d.amount, currency)}</span>
              <DueBadge status={d.status} />
              {d.covered > 0 && d.status !== "paid" && <span className="text-xs text-muted">{formatMoney(d.covered, currency)} paid · {formatMoney(d.amount - d.covered, currency)} left</span>}
              {d.note && <span dir="auto" className="text-xs text-muted">{d.note}</span>}
              {canPlan && d.status !== "paid" && (
                <span className="ml-auto flex gap-1">
                  <button className="rounded-md p-1.5 text-muted hover:bg-navy-50 hover:text-ink" aria-label={`Change payment due ${formatCairo(d.dueOn, "date")}`} onClick={() => onEdit(d)}><Pencil size={14} /></button>
                  <button className="rounded-md p-1.5 text-muted hover:bg-bad-bg hover:text-bad" aria-label={`Remove payment due ${formatCairo(d.dueOn, "date")}`}
                    onClick={() => runAction(deletePaymentDue(d.id), "Removed from the payment plan")}><Trash2 size={14} /></button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1.5 text-xs text-muted">Confirmed payments recorded after the plan was set count toward it, earliest due first. You are reminded before each date and told if it becomes overdue.</p>
    </section>
  );
}

function DueDialog({ enrollmentId, currency, due, onClose }: { enrollmentId: string; currency: string; due: PaymentDue | null; onClose: () => void }) {
  const { now } = useWorkspace();
  const runAction = useRunAction();
  const today = cairoParts(now).date;
  const [f, setF] = useState({ dueOn: due?.dueOn ?? "", amount: due ? String(due.amount) : "", note: due?.note ?? "" });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await runAction(savePaymentDue({ id: due?.id, enrollmentId, dueOn: f.dueOn, amount: Number(f.amount), note: f.note || undefined }), due ? "Payment plan updated" : "Added to the payment plan");
    setBusy(false);
    if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title={due ? "Change expected payment" : "Add expected payment"} description="When the customer has promised to pay, and how much."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !f.dueOn || !(Number(f.amount) > 0)} onClick={save}>{busy ? "Saving…" : "Save"}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Due date" required>{(p) => <Input type="date" min={today} value={f.dueOn} onChange={(e) => setF({ ...f, dueOn: e.target.value })} {...p} />}</Field>
        <Field label={`Amount (${currency})`} required>{(p) => <Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} {...p} />}</Field>
        <Field label="Note (optional)" className="sm:col-span-2">{(p) => <Input value={f.note} maxLength={300} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. Second installment, after salary" {...p} />}</Field>
      </div>
    </Dialog>
  );
}

// ── Submit a payment ─────────────────────────────────────────────────────

function PaymentDialog({ enrollmentId, currency, remaining, canPlan, firstPayment, onClose }: {
  enrollmentId: string; currency: string; remaining: number; canPlan: boolean; firstPayment: boolean; onClose: () => void;
}) {
  const { now } = useWorkspace();
  const runAction = useRunAction();
  const toast = useToast();
  const today = cairoParts(now).date;
  const [f, setF] = useState({ amount: "", paidOn: today, method: "instapay" as PaymentMethod, reference: "", note: "", kind: (firstPayment ? "deposit" : "installment") as PaymentKind });
  const [next, setNext] = useState({ dueOn: "", amount: "" });
  const [receipt, setReceipt] = useState<{ token: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const cash = f.method === "cash";
  const amount = Number(f.amount);
  const tooMuch = amount > remaining + 0.005;
  const leftAfter = Math.max(remaining - (amount || 0), 0);
  const askNext = canPlan && f.kind !== "full" && amount > 0 && leftAfter > 0.005;
  const pickKind = (kind: PaymentKind) => setF({ ...f, kind, amount: kind === "full" ? String(remaining) : f.amount });

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/receipts", { method: "POST", body });
      const json = (await res.json()) as { token?: string; name?: string; error?: string };
      if (!res.ok || !json.token) throw new Error(json.error ?? "Upload failed.");
      setReceipt({ token: json.token, name: json.name ?? file.name });
    } catch (e) {
      toast.error((e as Error).message);
      if (fileRef.current) fileRef.current.value = "";
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    const r = await runAction(submitPayment({
      enrollmentId, amount, paidOn: f.paidOn, method: f.method, reference: f.reference || undefined, note: f.note || undefined, receiptToken: receipt?.token, kind: f.kind,
    }), "Payment submitted. A manager will confirm it.");
    if (r.ok && askNext && next.dueOn && Number(next.amount) > 0) {
      await runAction(savePaymentDue({ enrollmentId, dueOn: next.dueOn, amount: Number(next.amount) }), "Next payment added to the plan");
    }
    setBusy(false);
    if (r.ok) onClose();
  };

  const fullWrong = f.kind === "full" && Math.abs(amount - remaining) > 0.005;
  const nextHalf = askNext && (!!next.dueOn !== Number(next.amount) > 0);
  const ready = amount > 0 && !tooMuch && !fullWrong && !nextHalf && f.paidOn && (cash || (f.reference.trim() && receipt));
  return (
    <Dialog open onClose={onClose} title="Record payment" description="It counts only after a manager confirms it."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || uploading || !ready} onClick={submit}>{busy ? "Submitting…" : "Submit for confirmation"}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Payment type" required className="sm:col-span-2">
          {(p) => (
            <Select value={f.kind} onChange={(e) => pickKind(e.target.value as PaymentKind)} {...p}>
              <option value="deposit">Deposit (first part)</option>
              <option value="installment">Installment (partial payment)</option>
              <option value="full">Full payment (the whole balance)</option>
            </Select>
          )}
        </Field>
        <Field label={`Amount (${currency})`} required
          error={tooMuch ? `More than the remaining ${formatMoney(remaining, currency)}` : fullWrong ? `A full payment is the whole ${formatMoney(remaining, currency)}` : undefined}
          hint={!tooMuch && !fullWrong ? `Remaining: ${formatMoney(remaining, currency)}` : undefined}>
          {(p) => <Input inputMode="decimal" value={f.amount} readOnly={f.kind === "full"} onChange={(e) => setF({ ...f, amount: e.target.value })} {...p} />}
        </Field>
        <Field label="Paid on" required>{(p) => <Input type="date" max={today} value={f.paidOn} onChange={(e) => setF({ ...f, paidOn: e.target.value })} {...p} />}</Field>
        <Field label="Method" required>
          {(p) => <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as PaymentMethod })} {...p}>{Object.entries(METHOD_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}
        </Field>
        <Field label="Reference" required={!cash} hint={cash ? "Optional for cash" : "Transfer or transaction number"}>
          {(p) => <Input dir="ltr" value={f.reference} maxLength={100} onChange={(e) => setF({ ...f, reference: e.target.value })} {...p} />}
        </Field>
        <div className="sm:col-span-2">
          <p className="mb-1.5 text-[13px] font-medium">Receipt{!cash && <span className="ml-0.5 text-bad" aria-hidden>*</span>}</p>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="sr-only" id="receipt-file" aria-label="Receipt file"
            onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); }} />
          <label htmlFor="receipt-file" className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-line px-3 py-3 text-sm hover:bg-navy-50">
            {uploading ? <Loader2 size={16} className="animate-spin" aria-hidden /> : receipt ? <Paperclip size={16} className="text-ok" aria-hidden /> : <Upload size={16} aria-hidden />}
            <span className="min-w-0 flex-1 truncate">{uploading ? "Uploading…" : receipt ? receipt.name : "Choose a photo or PDF of the receipt"}</span>
            <span className="hidden text-xs text-muted sm:inline">JPG, PNG, WebP or PDF · up to 10 MB</span>
          </label>
          <p className="mt-1 text-xs text-muted"><span className="sm:hidden">JPG, PNG, WebP or PDF, up to 10 MB. </span>Stored privately. Only managers and the people working on this customer can open it.</p>
        </div>
        <Field label="Note (optional)" className="sm:col-span-2">{(p) => <Textarea value={f.note} maxLength={1000} onChange={(e) => setF({ ...f, note: e.target.value })} {...p} />}</Field>
        {askNext && (
          <fieldset className="rounded-lg border border-line p-3 sm:col-span-2">
            <legend className="px-1 text-[13px] font-medium">Next payment (optional)</legend>
            <p className="mb-3 text-xs text-muted">{formatMoney(leftAfter, currency)} will be left. Add when the customer will pay next, to be reminded.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Next payment date">{(p) => <Input type="date" min={today} value={next.dueOn} onChange={(e) => setNext({ ...next, dueOn: e.target.value })} {...p} />}</Field>
              <Field label={`Next payment amount (${currency})`} error={nextHalf ? "Fill in both the date and the amount, or neither" : undefined}>
                {(p) => <Input inputMode="decimal" value={next.amount} placeholder={String(leftAfter)} onChange={(e) => setNext({ ...next, amount: e.target.value })} {...p} />}
              </Field>
            </div>
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}
