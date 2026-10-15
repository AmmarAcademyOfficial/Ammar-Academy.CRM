"use client";

import { AlertTriangle, CheckCircle2, CreditCard, Hourglass } from "lucide-react";
import { useState } from "react";
import { cn as clsx } from "@/components/ui/cn";
import { Card, EmptyState, Name, PageHeader, SkeletonRows, Stat } from "@/components/ui/misc";
import type { PaymentsPage as PaymentsData } from "@/domain/dto";
import { formatMoney } from "@/domain/rules";
import { SubmissionItem } from "@/features/lead-panel/payments-tab";
import { courseOf } from "@/lib/courses";
import { profileName } from "@/lib/lead-row";
import { useApi, useWorkspace } from "@/lib/workspace";

const TABS = [
  { id: "pending", label: "To confirm" },
  { id: "confirmed", label: "Confirmed" },
  { id: "closed", label: "Rejected and reversed" },
] as const;

export function PaymentsPage() {
  const { ref, openInquiry } = useWorkspace();
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("pending");
  const { data, loading } = useApi<PaymentsData>(`/api/payments?tab=${tab}`);
  const program = (id: string) => ref.programs.find((p) => p.id === id)?.code ?? "";

  return (
    <div>
      <PageHeader title="Payments" subtitle="Only payments you confirm count toward totals and support handover." />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Waiting for confirmation" value={data?.counts.pending ?? "–"} icon={<Hourglass size={14} />} tone={data?.counts.pending ? "warn" : undefined} />
        <Stat label="Confirmed today" value={data?.counts.confirmedToday ?? "–"} icon={<CheckCircle2 size={14} />} />
        <Stat label="Confirmed this month" icon={<CreditCard size={14} />}
          value={data ? (data.counts.confirmedThisMonth.length ? data.counts.confirmedThisMonth.map((m) => formatMoney(m.amount, m.currency)).join(" · ") : formatMoney(0, "EGP")) : "–"} />
      </div>

      {data && data.flagged.length > 0 && (
        <div role="alert" className="mt-5 rounded-[var(--radius-card)] border border-orange-500/40 bg-warn-bg p-4 text-sm">
          <p className="flex items-center gap-2 font-semibold text-warn"><AlertTriangle size={16} aria-hidden /> {data.flagged.length} handed-over customer{data.flagged.length === 1 ? "" : "s"} flagged after a reversal</p>
          <ul className="mt-2 space-y-1">
            {data.flagged.map((c) => (
              <li key={c.onboarding.id}>
                <button className="font-medium text-navy-700 underline" onClick={() => openInquiry(c.inquiryId)}>{c.customerName}</button>
                <span className="text-muted"> · {formatMoney(c.totals.paid, c.currency)} of {formatMoney(c.totals.agreed, c.currency)} confirmed</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div role="tablist" aria-label="Payment status" className="mb-4 mt-5 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={clsx("h-9 rounded-full px-4 text-sm font-medium", tab === t.id ? "bg-navy-900 text-white" : "border border-line bg-white hover:bg-navy-50")}>
            {t.label}{t.id === "pending" && data?.counts.pending ? ` (${data.counts.pending})` : ""}
          </button>
        ))}
      </div>

      {loading && !data && <Card><SkeletonRows rows={4} /></Card>}
      {data && data.rows.length === 0 && (
        <Card><EmptyState icon={<CheckCircle2 size={22} />} title={tab === "pending" ? "Nothing to confirm" : "Nothing here yet"}>{tab === "pending" ? "New payment submissions from agents appear here." : null}</EmptyState></Card>
      )}
      <div className="space-y-3">
        {data?.rows.map((r) => {
          const course = courseOf(ref, r.courseId);
          return (
            <Card key={r.payment.id} className="p-4">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <button className="text-left font-semibold text-navy-900 hover:underline" onClick={() => openInquiry(r.inquiryId)}><Name>{r.customerName}</Name></button>
                  <p className="text-xs text-muted">{course?.name ?? program(r.programId)} · sales: {profileName(ref, r.salesOwnerId)}</p>
                </div>
                <p className="text-xs text-muted tabular-nums">
                  {formatMoney(r.totals.paid, r.currency)} of {formatMoney(r.totals.agreed, r.currency)} confirmed
                  {r.totals.pending > 0 ? ` · ${formatMoney(r.totals.pending, r.currency)} pending` : ""}
                </p>
              </div>
              <SubmissionItem p={r.payment} currency={r.currency} customer={r.customerName} />
            </Card>
          );
        })}
      </div>
    </div>
  );
}
