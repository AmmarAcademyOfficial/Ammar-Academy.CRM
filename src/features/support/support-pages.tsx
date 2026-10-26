"use client";

import { EnrollmentsView } from "@/features/customers/enrollments-view";
import { isUnopenedCustomer } from "@/lib/lead-row";
import { AlertTriangle, Banknote, CalendarClock, CheckCircle2, Hand, Inbox, ListChecks, Users } from "lucide-react";
import { useState } from "react";
import { DueBadge, SupportStatusBadge, NewBadge } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { Card, CardHeader, EmptyState, Name, PageHeader, PhoneText, SkeletonRows, Stat } from "@/components/ui/misc";
import type { CustomerRow, PaymentDueRow, SupportWork } from "@/domain/dto";
import { cairoParts, formatCairo, formatMoney, formatRelative } from "@/domain/rules";
import { courseOf } from "@/lib/courses";
import { profileName } from "@/lib/lead-row";
import { useRunAction } from "@/lib/run-action";
import { useApi, useWorkspace } from "@/lib/workspace";
import { claimCustomer, completeSupportFollowUp } from "@/server/payment-actions";

function CustomerLine({ c, action }: { c: CustomerRow; action?: React.ReactNode }) {
  const { ref, now, openInquiry } = useWorkspace();
  const done = c.onboarding.checklist.filter((i) => i.doneAt).length;
  const total = c.onboarding.checklist.length;
  const overdue = c.nextDue && new Date(c.nextDue.dueAt) < now;
  return (
    <li className={clsx("flex flex-wrap items-center gap-3 px-4 py-3", isUnopenedCustomer(c.onboarding) && "bg-new-bg")} data-unopened={isUnopenedCustomer(c.onboarding) || undefined}>
      <button className="min-w-0 flex-1 text-left" onClick={() => openInquiry(c.inquiryId)}>
        <span className="flex flex-wrap items-center gap-2">
          <Name className="font-medium">{c.customerName}</Name>
          {isUnopenedCustomer(c.onboarding) && <NewBadge />}
          {c.studentName && <span className="text-xs text-muted">Student: {c.studentName}</span>}
          <SupportStatusBadge status={c.onboarding.status} />
          {c.onboarding.flaggedForReview && <span className="inline-flex items-center gap-1 text-xs font-medium text-warn"><AlertTriangle size={12} aria-hidden /> Flagged</span>}
        </span>
        <span className="mt-0.5 block text-xs text-muted">
          {courseOf(ref, c.courseId)?.name ?? "—"} · <PhoneText value={c.phone} /> · {formatMoney(c.totals.paid, c.currency)} of {formatMoney(c.totals.agreed, c.currency)} paid
          {c.totals.balance > 0 && <> · <span className="font-medium text-ink">{formatMoney(c.totals.balance, c.currency)} left</span></>}
        </span>
        <span className="mt-0.5 flex flex-wrap gap-x-3 text-xs">
          <span className="text-muted">Checklist {done}/{total}</span>
          {c.nextDue && <span className={overdue ? "font-medium text-bad" : "text-muted"}>{overdue ? "Overdue: " : "Next: "}{c.nextDue.label} · {formatCairo(c.nextDue.dueAt, "date")}</span>}
          {c.nextPayment && (
            <span className={c.nextPayment.status === "overdue" ? "font-medium text-bad" : "text-muted"} data-next-payment={c.nextPayment.status}>
              {c.nextPayment.status === "overdue" ? "Payment overdue: " : "Next payment: "}
              {formatMoney(c.nextPayment.amount - c.nextPayment.covered, c.currency)} · {formatCairo(c.nextPayment.dueOn, "date")}
            </span>
          )}
          {!c.onboarding.supportOwnerId && <span className="text-muted">Waiting {formatRelative(c.onboarding.createdAt, now).replace(" ago", "")}</span>}
        </span>
      </button>
      {action}
    </li>
  );
}

/** Support · My Work: the queue with Assign to Me, my customers, and what is due today. */
export function SupportMyWork() {
  const { me, now } = useWorkspace();
  const runAction = useRunAction();
  const { data, loading } = useApi<SupportWork>("/api/support-work");
  const [claiming, setClaiming] = useState<string | null>(null);
  const claim = async (id: string) => {
    setClaiming(id);
    await runAction(claimCustomer(id), "Customer assigned to you");
    setClaiming(null);
  };
  const due = (data?.followUps.length ?? 0) + (data?.overdueItems.length ?? 0);
  return (
    <div>
      <PageHeader title={`Good ${cairoParts(now).minutes < 720 ? "morning" : "afternoon"}, ${me.fullName.split(" ")[0]}`} subtitle="New customers to welcome, your onboarding list, and what is due today." />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Waiting in the queue" value={data?.queue.length ?? "–"} icon={<Inbox size={14} />} tone={data?.queue.length ? "warn" : undefined} />
        <Stat label="My customers onboarding" value={data?.mine.length ?? "–"} icon={<Users size={14} />} />
        <Stat label="Due today or overdue" value={data ? due : "–"} icon={<CalendarClock size={14} />} tone={due ? "bad" : undefined} />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="New customers" count={data?.queue.length} subtitle="Handed over after a confirmed payment. The first to click gets the customer." />
          {!data && loading ? <SkeletonRows rows={3} /> : data?.queue.length === 0 ? (
            <EmptyState icon={<CheckCircle2 size={20} />} title="Queue is empty">New customers appear here as soon as a manager confirms their payment.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {data?.queue.map((c) => (
                <CustomerLine key={c.onboarding.id} c={c} action={
                  <Button size="sm" variant="primary" icon={<Hand size={14} />} disabled={claiming === c.onboarding.id} onClick={() => claim(c.onboarding.id)}>Assign to Me</Button>
                } />
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Due today" count={due} subtitle="Your support follow-ups and overdue checklist steps" />
          {!data && loading ? <SkeletonRows rows={3} /> : due === 0 ? (
            <EmptyState icon={<CheckCircle2 size={20} />} title="Nothing due">You are up to date.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {data?.overdueItems.map((i) => <DueLine key={`${i.onboardingId}-${i.label}`} inquiryId={i.inquiryId} name={i.customerName} label={i.label} dueAt={i.dueAt} icon={<ListChecks size={14} aria-hidden />} />)}
              {data?.followUps.map((f) => (
                <DueLine key={f.id} inquiryId={f.inquiryId} name={f.customerName} label={f.note} dueAt={f.dueAt} icon={<CalendarClock size={14} aria-hidden />}
                  action={<Button size="sm" onClick={() => runAction(completeSupportFollowUp(f.id), "Follow-up done")}>Done</Button>} />
              ))}
            </ul>
          )}
        </Card>

        <PaymentsDueCard owner="mine" className="xl:col-span-2" />

        <Card className="xl:col-span-2">
          <CardHeader title="My customers" count={data?.mine.length} subtitle="Onboarding in progress (Active customers are on the Customers page)" />
          {!data && loading ? <SkeletonRows rows={3} /> : data?.mine.length === 0 ? (
            <EmptyState title="No customers in onboarding">Take a new customer from the queue to start.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">{data?.mine.map((c) => <CustomerLine key={c.onboarding.id} c={c} />)}</ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function DueLine({ inquiryId, name, label, dueAt, icon, action }: { inquiryId: string; name: string; label: string; dueAt: string; icon: React.ReactNode; action?: React.ReactNode }) {
  const { now, openInquiry } = useWorkspace();
  const overdue = new Date(dueAt) < now;
  return (
    <li className="flex items-center gap-3 px-4 py-2.5 text-sm">
      <span className="text-muted">{icon}</span>
      <button className="min-w-0 flex-1 text-left" onClick={() => openInquiry(inquiryId)}>
        <span className="block font-medium"><Name>{name}</Name></span>
        <span className="block text-xs"><span dir="auto">{label}</span> · <span className={overdue ? "font-medium text-bad" : "text-muted"}>{overdue ? "overdue since " : ""}{formatCairo(dueAt)}</span></span>
      </button>
      {action}
    </li>
  );
}

/** Customers (support) / Support (managers): every enrolled customer, with filters that combine (Part B). */
export function CustomersPage() {
  const { me } = useWorkspace();
  return (
    <div>
      <PageHeader title={me.role === "manager" ? "Support" : "Customers"} subtitle="Every enrolled customer. Filter by course, dates, status, payments and owners; every filter you set must match." />
      {me.role === "manager" && <PaymentsDueCard owner="any" className="mb-4" />}
      <EnrollmentsView />
    </div>
  );
}

/** Follow-ups for support: their own support follow-ups. */
export function SupportFollowUps() {
  const runAction = useRunAction();
  const { data, loading } = useApi<SupportWork>("/api/support-work");
  return (
    <div>
      <PageHeader title="Follow-ups" subtitle="Your support follow-ups due today and overdue. Add new ones from a customer's Support tab." />
      <Card>
        {!data && loading ? <SkeletonRows rows={3} /> : data?.followUps.length === 0 ? (
          <EmptyState icon={<CheckCircle2 size={22} />} title="Nothing due">You are up to date.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {data?.followUps.map((f) => (
              <DueLine key={f.id} inquiryId={f.inquiryId} name={f.customerName} label={f.note} dueAt={f.dueAt} icon={<CalendarClock size={14} aria-hidden />}
                action={<Button size="sm" onClick={() => runAction(completeSupportFollowUp(f.id), "Follow-up done")}>Done</Button>} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** Planned payments that are overdue or due in the next 7 days (support: their customers; managers: everyone or one agent's). */
export function PaymentsDueCard({ owner, className }: { owner: string; className?: string }) {
  const { ref, me, openInquiry } = useWorkspace();
  const { data, loading } = useApi<PaymentDueRow[]>(`/api/payment-dues?days=7&owner=${encodeURIComponent(owner)}`);
  const overdue = data?.filter((d) => d.status === "overdue").length ?? 0;
  return (
    <Card className={className}>
      <CardHeader
        title="Payments due"
        count={data?.length}
        subtitle={overdue ? `${overdue} overdue · the rest due in the next 7 days` : "Overdue and due in the next 7 days, from each customer's payment plan"}
      />
      {!data && loading ? <SkeletonRows rows={2} /> : data?.length === 0 ? (
        <EmptyState icon={<Banknote size={20} />} title="No payments due">Planned payments show here a week before they are due.</EmptyState>
      ) : (
        <ul className="divide-y divide-line" aria-label="Payments due">
          {data?.map((d) => (
            <li key={d.id} data-due={d.status}>
              <button className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left text-sm hover:bg-navy-50/60" onClick={() => openInquiry(d.inquiryId)}>
                <Name className="min-w-0 flex-1 font-medium">{d.customerName}</Name>
                <span className="font-semibold tabular-nums">{formatMoney(d.amount - d.covered, d.currency)}</span>
                <span className="w-24 text-xs text-muted">{formatCairo(d.dueOn, "date")}</span>
                <DueBadge status={d.status} />
                {me.role === "manager" && <span className="w-32 truncate text-xs text-muted">{d.supportOwnerId ? profileName(ref, d.supportOwnerId) : "No support owner"}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
