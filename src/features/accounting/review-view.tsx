"use client";

import { Check, ClipboardCheck, CreditCard, MessageSquareWarning } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Pill } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/form";
import { Card, CardHeader, EmptyState, Name, PhoneText, SkeletonRows } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import type { RefundRequestItem, ReviewQueue, ReviewQueueItem } from "@/domain/dto";
import { DeclineRefundDialog, REFUND_REASON, RefundDialog } from "@/features/lead-panel/refunds";
import { formatCairo, formatMoney } from "@/domain/rules";
import { useRunAction } from "@/lib/run-action";
import { useApi, useWorkspace } from "@/lib/workspace";
import { reviewEnrollment } from "@/server/payment-actions";

/**
 * To review (Phase 1): every new, additional or changed enrollment, for the accountant or a manager to
 * check. Reviewing never holds anything up: payments and the handover to support go ahead meanwhile.
 */
export function ReviewView() {
  const { data, loading, error } = useApi<ReviewQueue>("/api/review-queue");
  const [querying, setQuerying] = useState<ReviewQueueItem | null>(null);
  const [recording, setRecording] = useState<RefundRequestItem | null>(null);
  const [declining, setDeclining] = useState<RefundRequestItem | null>(null);
  const { openInquiry } = useWorkspace();
  const queried = data?.items.filter((i) => i.status === "queried") ?? [];
  const waiting = data?.items.filter((i) => i.status === "to_review") ?? [];
  return (
    <div className="space-y-4">
      {data && data.pendingPayments > 0 && (
        <Card className="flex flex-wrap items-center gap-3 p-4 text-sm">
          <CreditCard size={18} className="text-warn" aria-hidden />
          <span className="font-medium">{data.pendingPayments} payment{data.pendingPayments === 1 ? "" : "s"} waiting for confirmation</span>
          <Link href="/payments" className="ml-auto font-medium text-navy-700 hover:underline">Open Payments</Link>
        </Card>
      )}
      {error && <Card className="p-4 text-sm text-bad">{error}</Card>}
      {data && data.refundRequests.length > 0 && (
        <Card>
          <CardHeader title="Refund requests" subtitle="Support or sales asked for these. Record the refund once the money is paid back, or decline it with a reason." count={data.refundRequests.length} />
          <ul className="divide-y divide-line" aria-label="Refund requests">
            {data.refundRequests.map((r) => (
              <li key={r.id} className="space-y-1.5 px-4 py-3 text-sm" data-refund-request={r.customerName}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <button className="font-medium text-navy-900 hover:underline" onClick={() => openInquiry(r.inquiryId)}><Name>{r.customerName}</Name></button>
                  <span className="text-muted">{r.courseName}</span>
                  <span className="ml-auto font-semibold tabular-nums text-bad">−{formatMoney(r.amount, r.currency)}</span>
                </div>
                <p className="text-xs text-muted">{REFUND_REASON[r.reason]}{r.note ? <> · <span dir="auto">{r.note}</span></> : null} · paid {formatMoney(r.paid, r.currency)} of {formatMoney(r.agreed, r.currency)} · asked by {r.requestedBy ?? "—"} {formatCairo(r.requestedAt)}</p>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="navy" onClick={() => setRecording(r)} aria-label={`Record refund for ${r.customerName}`}>Record refund</Button>
                  <Button size="sm" variant="danger" onClick={() => setDeclining(r)} aria-label={`Decline refund for ${r.customerName}`}>Decline</Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {recording && (
        <RefundDialog enrollmentId={recording.enrollmentId} courseName={`${recording.customerName} · ${recording.courseName}`} currency={recording.currency}
          paid={recording.paid} agreed={recording.agreed}
          request={{ id: recording.id, enrollmentId: recording.enrollmentId, status: "requested", amount: recording.amount, reason: recording.reason, note: recording.note ?? undefined, hasReceipt: false }}
          onClose={() => setRecording(null)} />
      )}
      {declining && <DeclineRefundDialog refundId={declining.id} onClose={() => setDeclining(null)} />}
      <Card>
        <CardHeader title="Enrollments to review" subtitle="New, additional and changed enrollments. Nothing waits for this: support already has the customer." count={waiting.length} />
        {!data && loading ? <SkeletonRows rows={4} /> : waiting.length === 0 ? (
          <EmptyState icon={<ClipboardCheck size={22} />} title="Everything is reviewed">New and changed enrollments appear here.</EmptyState>
        ) : (
          <ul className="divide-y divide-line" aria-label="Enrollments to review">{waiting.map((i) => <ReviewLine key={i.enrollmentId} i={i} onQuery={() => setQuerying(i)} />)}</ul>
        )}
      </Card>
      {queried.length > 0 && (
        <Card>
          <CardHeader title="Queried" subtitle="Waiting for an answer from the person who entered it. Mark reviewed when it is sorted." count={queried.length} />
          <ul className="divide-y divide-line" aria-label="Queried enrollments">{queried.map((i) => <ReviewLine key={i.enrollmentId} i={i} onQuery={() => setQuerying(i)} />)}</ul>
        </Card>
      )}
      {data && data.recent.length > 0 && (
        <Card>
          <CardHeader title="Reviewed in the last 30 days" count={data.recent.length} />
          <ul className="divide-y divide-line text-sm">
            {data.recent.map((r) => (
              <li key={r.enrollmentId} className="flex flex-wrap gap-x-3 px-4 py-2.5">
                <Name className="font-medium">{r.customerName}</Name>
                <span className="text-muted">{r.courseName}</span>
                <span className="ml-auto text-xs text-muted">{r.reviewedBy} · {formatCairo(r.reviewedAt, "date")}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {querying && <QueryDialog i={querying} onClose={() => setQuerying(null)} />}
    </div>
  );
}

function ReviewLine({ i, onQuery }: { i: ReviewQueueItem; onQuery: () => void }) {
  const { openInquiry } = useWorkspace();
  const runAction = useRunAction();
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3" data-review-item={i.customerName}>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <button className="text-left font-medium hover:underline" onClick={() => openInquiry(i.inquiryId)}><Name>{i.customerName}</Name></button>
          {i.phone && <PhoneText value={i.phone} className="text-xs text-muted" />}
          <Pill className="bg-navy-50 text-navy-800">{i.reason}</Pill>
          {i.priceDiffers && <Pill className="bg-warn-bg text-warn">Price differs</Pill>}
        </p>
        <p className="mt-0.5 text-sm">
          {i.programName} · {i.courseName} · agreed <b className="font-semibold tabular-nums">{formatMoney(i.agreed, i.currency)}</b>
          {i.priceDiffers && i.price !== null && <> (price {formatMoney(i.price, i.currency)}{i.priceNote ? `: ${i.priceNote}` : ""})</>}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          Entered by {i.createdBy ?? "—"} · {formatCairo(i.createdAt, "date")} · credited to {i.salesAgentName ?? "nobody"} · confirmed {formatMoney(i.paid, i.currency)}
          {i.pending > 0 ? ` · ${formatMoney(i.pending, i.currency)} waiting` : ""}
        </p>
        {i.status === "queried" && i.note && (
          <p className="mt-1 flex items-start gap-1 text-xs font-medium text-warn"><MessageSquareWarning size={13} className="mt-0.5 shrink-0" aria-hidden /> {i.reviewedBy}: <span dir="auto">{i.note}</span></p>
        )}
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="navy" icon={<Check size={14} />} onClick={() => runAction(reviewEnrollment(i.enrollmentId, "reviewed"), "Marked as reviewed")} aria-label={`Mark ${i.customerName} · ${i.courseName} reviewed`}>Reviewed</Button>
        {i.status !== "queried" && <Button size="sm" onClick={onQuery} aria-label={`Query ${i.customerName} · ${i.courseName}`}>Query…</Button>}
      </div>
    </li>
  );
}

function QueryDialog({ i, onClose }: { i: ReviewQueueItem; onClose: () => void }) {
  const runAction = useRunAction();
  const [note, setNote] = useState("");
  return (
    <Dialog open onClose={onClose} title={`Query ${i.courseName}`} description={`${i.customerName}. The person who entered it, the person credited and the managers are told. Nothing waits for the answer.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!note.trim()} onClick={async () => { if ((await runAction(reviewEnrollment(i.enrollmentId, "queried", note), "Query sent")).ok) onClose(); }}>Send query</Button></>}>
      <Field label="What needs checking?" required>{(p) => <Textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. The discount was not approved" {...p} />}</Field>
    </Dialog>
  );
}
