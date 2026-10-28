"use client";

import { HandCoins, Paperclip, X } from "lucide-react";
import { useState } from "react";
import { Pill } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Dialog } from "@/components/ui/overlay";
import { cairoParts, formatCairo, formatMoney } from "@/domain/rules";
import type { PaymentMethod, Refund, RefundOutcome, RefundReason } from "@/domain/types";
import { METHOD_LABEL } from "@/lib/courses";
import { profileName } from "@/lib/lead-row";
import { useRunAction } from "@/lib/run-action";
import { useWorkspace } from "@/lib/workspace";
import { declineRefund, recordRefund, requestRefund } from "@/server/refund-actions";
import { ReceiptPicker } from "./payments-tab";

export const REFUND_REASON: Record<RefundReason, string> = {
  withdrew: "Withdrew from the course",
  course_changed: "Course cancelled or moved",
  overpaid: "Paid too much",
  goodwill: "Goodwill or discount",
  other: "Other",
};

/** Refunded / Partly refunded, from what was confirmed and what went back. */
export function RefundBadge({ refunded, paid }: { refunded: number; paid: number }) {
  if (refunded <= 0) return null;
  return paid <= 0.005
    ? <Pill className="bg-bad-bg text-bad">Refunded</Pill>
    : <Pill className="bg-warn-bg text-warn">Partly refunded</Pill>;
}

/** The Refunds list on a course card: recorded refunds, an open request, declined requests. */
export function RefundsList({ refunds, currency }: { refunds: Refund[]; currency: string }) {
  const { ref } = useWorkspace();
  if (refunds.length === 0) return null;
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Refunds</h4>
      <ul className="space-y-2" aria-label="Refunds">
        {refunds.map((r) => (
          <li key={r.id} className="rounded-lg border border-line p-3 text-sm" data-refund={r.status}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-semibold tabular-nums text-bad">−{formatMoney(r.amount, currency)}</span>
              {r.status === "recorded" && <Pill className="bg-bad-bg text-bad">Refund</Pill>}
              {r.status === "requested" && <Pill className="bg-warn-bg text-warn">Requested</Pill>}
              {r.status === "declined" && <Pill className="bg-[#eeeff3] text-[#4b4e66]">Declined</Pill>}
              <span className="text-xs text-muted">{REFUND_REASON[r.reason]}{r.status === "recorded" && r.outcome ? ` · ${r.outcome === "withdraw" ? "Withdrew" : "Keeps studying"}` : ""}</span>
            </div>
            <p className="mt-1 text-xs text-muted">
              {r.status === "recorded" && r.method && <>{METHOD_LABEL[r.method]} · paid back {r.refundedOn ? formatCairo(r.refundedOn, "date") : ""}{r.reference ? <> · ref <span dir="ltr">{r.reference}</span></> : null} · recorded by {profileName(ref, r.recordedById)}</>}
              {r.status !== "recorded" && r.requestedById && <>Requested by {profileName(ref, r.requestedById)}{r.requestedAt ? ` · ${formatCairo(r.requestedAt)}` : ""}</>}
              {r.status === "declined" && r.declinedById && <> · declined by {profileName(ref, r.declinedById)}</>}
            </p>
            {r.hasReceipt && (
              <a href={`/api/refund-receipts/${r.id}`} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-navy-700 hover:underline">
                <Paperclip size={12} aria-hidden /> {r.receiptName ?? "Receipt"}
              </a>
            )}
            {r.note && <p dir="auto" className="mt-1">{r.note}</p>}
            {r.declineReason && <p className="mt-1 text-bad">Declined: {r.declineReason}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Support and sales: ask for a refund. Managers and the accountant are told and decide. */
export function RequestRefundDialog({ enrollmentId, courseName, currency, paid, onClose }: {
  enrollmentId: string; courseName: string; currency: string; paid: number; onClose: () => void;
}) {
  const runAction = useRunAction();
  const [f, setF] = useState({ amount: "", reason: "" as RefundReason | "", note: "" });
  const [busy, setBusy] = useState(false);
  const amount = Number(f.amount);
  const tooMuch = amount > paid + 0.005;
  const ready = amount > 0 && !tooMuch && f.reason && (f.reason !== "other" || f.note.trim());
  const submit = async () => {
    if (!ready || !f.reason) return;
    setBusy(true);
    const r = await runAction(requestRefund({ enrollmentId, amount, reason: f.reason, note: f.note || undefined }), "Refund requested. A manager or the accountant will decide.");
    setBusy(false);
    if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title="Request refund" description={`${courseName}. A manager or the accountant records the refund or declines it; you are told either way.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !ready} onClick={submit}>{busy ? "Sending…" : "Request refund"}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label={`Amount (${currency})`} required error={tooMuch ? `More than the ${formatMoney(paid, currency)} confirmed` : undefined}
          hint={!tooMuch ? `Confirmed paid: ${formatMoney(paid, currency)}` : undefined}>
          {(p) => <Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} {...p} />}
        </Field>
        <Field label="Reason" required>
          {(p) => (
            <Select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value as RefundReason })} {...p}>
              <option value="">Choose…</option>
              {Object.entries(REFUND_REASON).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          )}
        </Field>
        <Field label={f.reason === "other" ? "Note" : "Note (optional)"} required={f.reason === "other"} className="sm:col-span-2">
          {(p) => <Textarea value={f.note} maxLength={500} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. Moving abroad next month" {...p} />}
        </Field>
      </div>
    </Dialog>
  );
}

/** Managers and the accountant: record a refund (their own, or a request), which counts at once. */
export function RefundDialog({ enrollmentId, courseName, currency, paid, agreed, request, onClose }: {
  enrollmentId: string; courseName: string; currency: string; paid: number; agreed: number; request?: Refund; onClose: () => void;
}) {
  const { now } = useWorkspace();
  const runAction = useRunAction();
  const today = cairoParts(now).date;
  const [f, setF] = useState({
    amount: request ? String(request.amount) : "", refundedOn: today, method: "instapay" as PaymentMethod, reference: "",
    reason: (request?.reason ?? "") as RefundReason | "", note: request?.note ?? "",
    outcome: (request?.reason === "withdrew" || request?.reason === "course_changed" ? "withdraw" : "") as RefundOutcome | "",
  });
  const [receipt, setReceipt] = useState<{ token: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const cash = f.method === "cash";
  const amount = Number(f.amount);
  const tooMuch = amount > paid + 0.005;
  const ready = amount > 0 && !tooMuch && f.refundedOn && f.reason && f.outcome && (cash || f.reference.trim()) && (f.reason !== "other" || f.note.trim());
  const submit = async () => {
    if (!ready || !f.reason || !f.outcome) return;
    setBusy(true);
    const r = await runAction(recordRefund({
      requestId: request?.id, enrollmentId, amount, refundedOn: f.refundedOn, method: f.method, reference: f.reference || undefined,
      receiptToken: receipt?.token, reason: f.reason, note: f.note || undefined, outcome: f.outcome,
    }), null);
    setBusy(false);
    if (r.ok) {
      const v = r.value;
      runAction(Promise.resolve({ ok: true as const, value: null }), v.withdrawn
        ? `Refund recorded. The customer withdrew${v.sessionsRemoved ? `; ${v.sessionsRemoved} future session${v.sessionsRemoved === 1 ? "" : "s"} removed` : ""}${v.duesCancelled ? `; ${v.duesCancelled} planned payment${v.duesCancelled === 1 ? "" : "s"} cancelled` : ""}${v.paymentsRejected ? `; ${v.paymentsRejected} payment${v.paymentsRejected === 1 ? "" : "s"} waiting for review rejected` : ""}.`
        : v.flagged ? "Refund recorded. The customer is now below the handover rule and was flagged for review." : "Refund recorded. The agreed total was lowered by the refund.");
      onClose();
    }
  };
  return (
    <Dialog open onClose={onClose} title="Record refund"
      description={`${courseName}. It counts at once: Paid becomes ${formatMoney(Math.max(paid - (amount || 0), 0), currency)}. The support owner and the credited agent are told.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={<HandCoins size={14} />} disabled={busy || uploading || !ready} onClick={submit}>{busy ? "Saving…" : "Record refund"}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label={`Amount (${currency})`} required error={tooMuch ? `More than the ${formatMoney(paid, currency)} confirmed` : undefined}
          hint={!tooMuch ? `Confirmed paid: ${formatMoney(paid, currency)}` : undefined}>
          {(p) => <Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} {...p} />}
        </Field>
        <Field label="Paid back on" required>{(p) => <Input type="date" max={today} value={f.refundedOn} onChange={(e) => setF({ ...f, refundedOn: e.target.value })} {...p} />}</Field>
        <Field label="Method" required>
          {(p) => <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as PaymentMethod })} {...p}>{Object.entries(METHOD_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}
        </Field>
        <Field label="Reference" required={!cash} hint={cash ? "Optional for cash" : "Transfer or transaction number"}>
          {(p) => <Input dir="ltr" value={f.reference} maxLength={100} onChange={(e) => setF({ ...f, reference: e.target.value })} {...p} />}
        </Field>
        <ReceiptPicker id="refund-receipt-file" required={false} receipt={receipt} setReceipt={setReceipt} onUploading={setUploading} />
        <Field label="Reason" required>
          {(p) => (
            <Select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value as RefundReason })} {...p}>
              <option value="">Choose…</option>
              {Object.entries(REFUND_REASON).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          )}
        </Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-1.5 text-[13px] font-medium text-ink">What happens to the course<span className="ml-0.5 text-bad" aria-hidden>*</span></legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line p-3 text-sm has-[:checked]:border-navy-700 has-[:checked]:bg-navy-50">
              <input type="radio" name="refund-outcome" className="mt-0.5 accent-navy-900" checked={f.outcome === "withdraw"} onChange={() => setF({ ...f, outcome: "withdraw" })} />
              <span><span className="font-medium">Withdraw</span><span className="block text-xs text-muted">The customer leaves the course: future sessions are removed, unpaid planned payments are cancelled, the teacher stops and support shows Withdrawn.</span></span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line p-3 text-sm has-[:checked]:border-navy-700 has-[:checked]:bg-navy-50">
              <input type="radio" name="refund-outcome" className="mt-0.5 accent-navy-900" checked={f.outcome === "keep"} onChange={() => setF({ ...f, outcome: "keep" })} />
              <span><span className="font-medium">Keep studying</span><span className="block text-xs text-muted">The agreed total drops by the refund (now {formatMoney(Math.max(agreed - (amount || 0), 0), currency)}) and the course continues.</span></span>
            </label>
          </div>
        </fieldset>
        <Field label={f.reason === "other" ? "Note" : "Note (optional)"} required={f.reason === "other"} className="sm:col-span-2">
          {(p) => <Textarea value={f.note} maxLength={500} onChange={(e) => setF({ ...f, note: e.target.value })} {...p} />}
        </Field>
      </div>
    </Dialog>
  );
}

/** Managers and the accountant decline a request; the person who asked is told why. */
export function DeclineRefundDialog({ refundId, onClose }: { refundId: string; onClose: () => void }) {
  const runAction = useRunAction();
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onClose={onClose} title="Decline refund request" description="The person who asked is told your reason."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" icon={<X size={14} />} disabled={busy || !why.trim()} onClick={async () => {
        setBusy(true);
        const r = await runAction(declineRefund(refundId, why), "Refund request declined");
        setBusy(false);
        if (r.ok) onClose();
      }}>Decline</Button></>}>
      <Field label="Reason" required>{(p) => <Input value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. The course has not started; offer a transfer instead" {...p} />}</Field>
    </Dialog>
  );
}
