"use client";

import { AlertTriangle, Banknote, Clock, Download, Paperclip, Receipt, Search, Wallet } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { DueBadge, SubmissionBadge } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { Input, Select } from "@/components/ui/form";
import { Card, CardHeader, EmptyState, Name, PageHeader, SkeletonRows, Stat } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import { academyMonth, daysBetween, periodRange, PERIODS, shiftDay, sumByCurrency, type Period } from "@/domain/accounting";
import type { AccountingCustomer, AccountingData, AccountingPayment, MoneyTotal } from "@/domain/dto";
import { cairoParts, formatCairo, formatMoney } from "@/domain/rules";
import type { PaymentMethod, SubmissionStatus } from "@/domain/types";
import { SubmissionItem } from "@/features/lead-panel/payments-tab";
import { formatDay } from "@/features/leads/filters";
import { CourseTypeChip } from "@/features/settings/courses-settings";
import { KIND_LABEL, METHOD_LABEL, courseOf } from "@/lib/courses";
import { toCsv } from "@/lib/csv";
import { profileName } from "@/lib/lead-row";
import { useApi, useWorkspace } from "@/lib/workspace";
import { TeachersView } from "./teachers-view";

type Tab = "overview" | "payments" | "customers" | "agents" | "teachers";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "payments", label: "Payments" },
  { id: "customers", label: "Customers" },
  { id: "agents", label: "Sales agents" },
  { id: "teachers", label: "Teachers" },
];

interface Filters {
  programId: string;
  courseTypeId: string;
  courseId: string;
  salesAgentId: string;
  supportAgentId: string;
  method: string;
}
const NO_FILTERS: Filters = { programId: "", courseTypeId: "", courseId: "", salesAgentId: "", supportAgentId: "", method: "" };

const moneyList = (list: MoneyTotal[]) => (list.length ? list.map((m) => formatMoney(m.amount, m.currency)).join(" · ") : formatMoney(0, "EGP"));
const csvMoney = (list: MoneyTotal[]) => list.map((m) => `${m.amount} ${m.currency}`).join(" + ") || "0";

function download(name: string, rows: unknown[][]) {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Accounting (managers and accountants): money in, balances, payments and sales agents. */
export function AccountingPage() {
  const { ref, now } = useWorkspace();
  const today = cairoParts(now).date;
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => (TABS.some((t) => t.id === params.get("tab")) ? (params.get("tab") as Tab) : "overview"));
  const [period, setPeriod] = useState<Period>("academy");
  const [custom, setCustom] = useState({ from: shiftDay(today, -29), to: today });
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const range = periodRange(period, today, custom);
  const valid = !!range.from && !!range.to && range.from <= range.to;
  const teachersTab = tab === "teachers";
  const { data, loading, error } = useApi<AccountingData>(valid && !teachersTab ? `/api/accounting?from=${range.from}&to=${range.to}` : null);

  const salesStaff = ref.profiles.filter((p) => p.role === "sales" || (p.role === "manager" && data?.customers.some((c) => c.salesAgentId === p.id)));
  const supportStaff = ref.profiles.filter((p) => p.role === "support");
  const courses = ref.courses.filter((c) => (!f.programId || c.programId === f.programId) && (!f.courseTypeId || c.courseTypeId === f.courseTypeId));

  const matchCommon = (x: { programId: string; courseTypeId: string | null; courseId: string; salesAgentId: string | null; supportOwnerId: string | null }) =>
    (!f.programId || x.programId === f.programId) &&
    (!f.courseTypeId || x.courseTypeId === f.courseTypeId) &&
    (!f.courseId || x.courseId === f.courseId) &&
    (!f.salesAgentId || x.salesAgentId === f.salesAgentId) &&
    (!f.supportAgentId || x.supportOwnerId === f.supportAgentId);
  const payments = useMemo(() => (data?.payments ?? []).filter((p) => matchCommon(p) && (!f.method || p.payment.method === f.method)), [data, f]); // eslint-disable-line react-hooks/exhaustive-deps
  const customers = useMemo(() => (data?.customers ?? []).filter(matchCommon), [data, f]); // eslint-disable-line react-hooks/exhaustive-deps
  const academy = academyMonth(today);
  const activeFilters = Object.values(f).filter(Boolean).length;

  return (
    <div>
      <PageHeader title="Accounting" subtitle={teachersTab ? "Teacher salaries per Academy month (26th to 25th), from the session hours support records. Currencies are never added together." : "Confirmed payments by the date the customer paid. Amounts in different currencies are never added together."} />

      {!teachersTab && <Card className="mb-4 p-3">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 [&>*]:min-w-0">
          <Select aria-label="Period" className="h-9" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
          {period === "custom" ? (
            <div className="flex items-center gap-2">
              <Input aria-label="From" type="date" className="h-9 min-w-0" value={custom.from} max={custom.to || today} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
              <span className="text-muted">–</span>
              <Input aria-label="To" type="date" className="h-9 min-w-0" value={custom.to} min={custom.from} max={today} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
            </div>
          ) : (
            <p className="flex flex-wrap items-center gap-x-2 px-1 text-sm text-muted">
              <span data-testid="range">{formatDay(range.from)} – {formatDay(range.to)}</span>
              {(period === "academy" || period === "last_academy") && <span className="font-medium text-ink">{period === "academy" ? academy.label : academyMonth(today, -1).label}</span>}
            </p>
          )}
          <Select aria-label="Program" className="h-9" value={f.programId} onChange={(e) => setF({ ...f, programId: e.target.value, courseId: "" })}>
            <option value="">All programs</option>
            {ref.programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          <Select aria-label="Course type" className="h-9" value={f.courseTypeId} onChange={(e) => setF({ ...f, courseTypeId: e.target.value, courseId: "" })}>
            <option value="">All course types</option>
            {ref.courseTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Select aria-label="Course" className="h-9" value={f.courseId} onChange={(e) => setF({ ...f, courseId: e.target.value })}>
            <option value="">All courses</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select aria-label="Sales agent" className="h-9" value={f.salesAgentId} onChange={(e) => setF({ ...f, salesAgentId: e.target.value })}>
            <option value="">All sales agents</option>
            {salesStaff.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
          </Select>
          <Select aria-label="Support agent" className="h-9" value={f.supportAgentId} onChange={(e) => setF({ ...f, supportAgentId: e.target.value })}>
            <option value="">All support agents</option>
            {supportStaff.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
          </Select>
          <Select aria-label="Payment method" className="h-9" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            <option value="">All methods</option>
            {Object.entries(METHOD_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </div>
        {activeFilters > 0 && (
          <button className="mt-2 px-1 text-xs font-medium text-navy-700 hover:underline" onClick={() => setF(NO_FILTERS)}>Clear {activeFilters} filter{activeFilters === 1 ? "" : "s"}</button>
        )}
      </Card>}

      <div role="tablist" aria-label="Accounting views" className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={clsx("h-9 rounded-full px-4 text-sm font-medium", tab === t.id ? "bg-navy-900 text-white" : "border border-line bg-white hover:bg-navy-50")}>
            {t.label}
          </button>
        ))}
      </div>

      {teachersTab && <TeachersView />}
      {!teachersTab && !valid && <Card className="p-4 text-sm text-bad">Choose a start date before the end date.</Card>}
      {!teachersTab && error && <Card className="p-4 text-sm text-bad">{error}</Card>}
      {!teachersTab && valid && !data && loading && <Card><SkeletonRows rows={5} /></Card>}
      {data && tab === "overview" && <Overview payments={payments} customers={customers} range={range} />}
      {data && tab === "payments" && <PaymentsView payments={payments} range={range} />}
      {data && tab === "customers" && <CustomersView customers={customers} />}
      {data && tab === "agents" && <AgentsView payments={payments} customers={customers} range={range} />}
    </div>
  );
}

// ── Overview ─────────────────────────────────────────────────────────────

function Overview({ payments, customers, range }: { payments: AccountingPayment[]; customers: AccountingCustomer[]; range: { from: string; to: string } }) {
  const { ref } = useWorkspace();
  const confirmed = payments.filter((p) => p.payment.status === "confirmed");
  const pending = payments.filter((p) => p.payment.status === "pending");
  const moneyIn = sumByCurrency(confirmed.map((p) => ({ amount: p.payment.amount, currency: p.currency })));
  const owed = sumByCurrency(customers.map((c) => ({ amount: c.balance, currency: c.currency })));
  const overdueCustomers = customers.filter((c) => c.overdueLeft > 0);
  const overdue = sumByCurrency(overdueCustomers.map((c) => ({ amount: c.overdueLeft, currency: c.currency })));
  const main = moneyIn[0]?.currency ?? "EGP";

  const breakdown = (key: (p: AccountingPayment) => string) => {
    const groups = new Map<string, AccountingPayment[]>();
    for (const p of confirmed) groups.set(key(p), [...(groups.get(key(p)) ?? []), p]);
    return [...groups.entries()]
      .map(([label, list]) => ({ label, count: list.length, total: sumByCurrency(list.map((p) => ({ amount: p.payment.amount, currency: p.currency }))) }))
      .sort((a, b) => (b.total[0]?.amount ?? 0) - (a.total[0]?.amount ?? 0));
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Money in (confirmed)" value={<span data-testid="money-in">{moneyList(moneyIn)}</span>} hint={`${confirmed.length} payment${confirmed.length === 1 ? "" : "s"} · ${formatDay(range.from)} – ${formatDay(range.to)}`} icon={<Banknote size={14} />} tone="ok" />
        <Stat label="Waiting for review" value={moneyList(sumByCurrency(pending.map((p) => ({ amount: p.payment.amount, currency: p.currency }))))} hint={`${pending.length} payment${pending.length === 1 ? "" : "s"}, not counted yet`} icon={<Clock size={14} />} tone={pending.length ? "warn" : "default"} />
        <Stat label="Still owed by customers" value={<span data-testid="still-owed">{moneyList(owed)}</span>} hint={`${customers.filter((c) => c.balance > 0).length} customers with a balance (today)`} icon={<Wallet size={14} />} />
        <Stat label="Overdue planned payments" value={<span data-testid="overdue">{moneyList(overdue)}</span>} hint={`${overdueCustomers.length} customer${overdueCustomers.length === 1 ? "" : "s"} (today)`} icon={<AlertTriangle size={14} />} tone={overdueCustomers.length ? "bad" : "default"} />
      </div>

      <DailyChart payments={confirmed.filter((p) => p.currency === main)} range={range} currency={main} />

      <div className="grid gap-5 lg:grid-cols-2">
        <Breakdown title="By course type" rows={breakdown((p) => (p.courseTypeId ? ref.courseTypes.find((t) => t.id === p.courseTypeId)?.name : undefined) ?? "No course type")} />
        <Breakdown title="By payment type" rows={breakdown((p) => (p.payment.kind ? KIND_LABEL[p.payment.kind] : "Not set"))} />
        <Breakdown title="By program" rows={breakdown((p) => ref.programs.find((x) => x.id === p.programId)?.name ?? "—")} />
        <Breakdown title="By method" rows={breakdown((p) => METHOD_LABEL[p.payment.method])} />
      </div>
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: { label: string; count: number; total: MoneyTotal[] }[] }) {
  return (
    <Card>
      <CardHeader title={title} />
      {rows.length === 0 ? <p className="px-4 py-6 text-sm text-muted">No confirmed payments in this period.</p> : (
        <table className="w-full text-sm" aria-label={title}>
          <thead><tr className="text-left text-xs text-muted"><th className="px-4 py-2 font-medium">Group</th><th className="px-4 py-2 text-right font-medium">Payments</th><th className="px-4 py-2 text-right font-medium">Confirmed</th></tr></thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.label}><td className="px-4 py-2">{r.label}</td><td className="px-4 py-2 text-right tabular-nums">{r.count}</td><td className="px-4 py-2 text-right font-medium tabular-nums">{moneyList(r.total)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/** Money in per day for one currency: one series, so one hue and no legend; hover any day for its value. */
function DailyChart({ payments, range, currency }: { payments: AccountingPayment[]; range: { from: string; to: string }; currency: string }) {
  const days = daysBetween(range.from, range.to);
  const [hover, setHover] = useState<string | null>(null);
  if (days.length > 62) return null;
  const byDay = new Map<string, number>();
  for (const p of payments) byDay.set(p.payment.paidOn, (byDay.get(p.payment.paidOn) ?? 0) + p.payment.amount);
  const max = Math.max(0, ...byDay.values());
  const total = [...byDay.values()].reduce((a, b) => a + b, 0);
  const H = 160;
  const shown = hover ?? null;
  return (
    <Card>
      <CardHeader title={`Money in per day (${currency})`} subtitle={shown ? `${formatDay(shown)}: ${formatMoney(byDay.get(shown) ?? 0, currency)}` : `${formatMoney(total, currency)} confirmed in ${days.length} day${days.length === 1 ? "" : "s"} · hover a day for its total`} />
      {max === 0 ? <p className="px-4 py-6 text-sm text-muted">No confirmed {currency} payments in this period.</p> : (
        <div className="px-4 pb-4 pt-3">
          <div className="relative" style={{ height: H }} role="group" aria-label={`Money in per day, ${currency}: ${formatMoney(total, currency)} in total, highest day ${formatMoney(max, currency)}`}>
            <div className="absolute inset-x-0 top-0 border-t border-dashed border-line" aria-hidden />
            <span className="absolute right-0 top-0 -translate-y-full pb-0.5 text-[11px] text-muted" aria-hidden>{formatMoney(max, currency)}</span>
            <div className="absolute inset-x-0 bottom-0 border-t border-line" aria-hidden />
            <div className="absolute inset-0 flex items-end gap-[2px]">
              {days.map((d) => {
                const v = byDay.get(d) ?? 0;
                return (
                  <button
                    key={d}
                    type="button"
                    className="group flex h-full min-w-0 flex-1 items-end"
                    aria-label={`${formatDay(d)}: ${formatMoney(v, currency)}`}
                    onMouseEnter={() => setHover(d)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(d)}
                    onBlur={() => setHover(null)}
                  >
                    <span
                      className={clsx("block w-full rounded-t-[4px] bg-navy-700 transition-opacity", hover && hover !== d && "opacity-40")}
                      style={{ height: v ? `${Math.max(2, (v / max) * H)}px` : "0px" }}
                    />
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-muted" aria-hidden>
            <span>{formatDay(range.from)}</span>
            {days.length > 2 && <span>{formatDay(days[Math.floor(days.length / 2)])}</span>}
            <span>{formatDay(range.to)}</span>
          </div>
        </div>
      )}
    </Card>
  );
}

// ── Payments ─────────────────────────────────────────────────────────────

const STATUS_OPTIONS: { id: "all" | SubmissionStatus; label: string }[] = [
  { id: "confirmed", label: "Confirmed" },
  { id: "pending", label: "Waiting for review" },
  { id: "rejected", label: "Rejected" },
  { id: "reversed", label: "Reversed" },
  { id: "all", label: "All statuses" },
];

function PaymentsView({ payments, range }: { payments: AccountingPayment[]; range: { from: string; to: string } }) {
  const { ref, me } = useWorkspace();
  const [status, setStatus] = useState<"all" | SubmissionStatus>("confirmed");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<AccountingPayment | null>(null);
  const pending = payments.filter((p) => p.payment.status === "pending");
  const needle = q.trim().toLowerCase();
  const rows = payments.filter((p) => (status === "all" || p.payment.status === status) && (!needle || p.customerName.toLowerCase().includes(needle) || (p.payment.reference ?? "").toLowerCase().includes(needle)));
  const canDecide = me.role === "manager" || me.role === "accountant";
  const total = sumByCurrency(rows.filter((p) => p.payment.status === "confirmed").map((p) => ({ amount: p.payment.amount, currency: p.currency })));

  const exportCsv = () => download(`payments-${range.from}-to-${range.to}.csv`, [
    ["Paid on", "Customer", "Student", "Program", "Course", "Type", "Method", "Reference", "Amount", "Currency", "Status", "Sales agent", "Recorded by", "Decided by"],
    ...rows.map((p) => [
      p.payment.paidOn, p.customerName, p.studentName ?? "", ref.programs.find((x) => x.id === p.programId)?.code ?? "", courseOf(ref, p.courseId)?.name ?? "",
      p.payment.kind ? KIND_LABEL[p.payment.kind] : "", METHOD_LABEL[p.payment.method], p.payment.reference ?? "", p.payment.amount, p.currency, p.payment.status,
      p.salesAgentId ? profileName(ref, p.salesAgentId) : "", profileName(ref, p.payment.submittedById), p.payment.decidedById ? profileName(ref, p.payment.decidedById) : "",
    ]),
  ]);

  return (
    <div className="space-y-5">
      {canDecide && pending.length > 0 && (
        <Card>
          <CardHeader title="Waiting for review" count={pending.length} subtitle="Open the receipt, then confirm or reject. Only confirmed payments count." />
          <div className="space-y-3 p-4">
            {pending.map((p) => (
              <div key={p.payment.id}>
                <p className="mb-1 text-sm font-semibold"><Name>{p.customerName}</Name> <span className="font-normal text-muted">· {courseOf(ref, p.courseId)?.name ?? "—"}</span></p>
                <SubmissionItem p={p.payment} currency={p.currency} customer={p.customerName} />
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Payments"
          count={rows.length}
          subtitle={`Paid ${formatDay(range.from)} – ${formatDay(range.to)}${total.length ? ` · ${moneyList(total)} confirmed` : ""}`}
          action={<Button size="sm" icon={<Download size={14} />} onClick={exportCsv} disabled={!rows.length}>Download CSV</Button>}
        />
        <div className="grid gap-2 border-b border-line p-3 sm:grid-cols-2">
          <label className="relative">
            <span className="sr-only">Search payments</span>
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <Input className="h-9 pl-8" placeholder="Customer or reference" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <Select aria-label="Payment status" className="h-9" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            {STATUS_OPTIONS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </Select>
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={<Receipt size={20} />} title="No payments match">Try another period, status or filter.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm" aria-label="Payments">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium">Paid on</th><th className="px-4 py-2 font-medium">Customer</th><th className="px-4 py-2 font-medium">Course</th>
                  <th className="px-4 py-2 font-medium">Type</th><th className="px-4 py-2 font-medium">Method</th><th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-4 py-2 font-medium">Status</th><th className="px-4 py-2 font-medium">Sales agent</th><th className="px-4 py-2 font-medium">Recorded by</th><th className="px-4 py-2"><span className="sr-only">Receipt</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((p) => (
                  <tr key={p.payment.id} className="cursor-pointer hover:bg-navy-50/60" onClick={() => setOpen(p)} data-payment={p.payment.id}>
                    <td className="whitespace-nowrap px-4 py-2">{formatDay(p.payment.paidOn)}</td>
                    <td className="px-4 py-2"><button className="text-left font-medium hover:underline" onClick={(e) => { e.stopPropagation(); setOpen(p); }}><Name>{p.customerName}</Name></button></td>
                    <td className="px-4 py-2 text-muted">{courseOf(ref, p.courseId)?.name ?? "—"}</td>
                    <td className="px-4 py-2">{p.payment.kind ? KIND_LABEL[p.payment.kind] : "—"}</td>
                    <td className="px-4 py-2 text-muted">{METHOD_LABEL[p.payment.method as PaymentMethod]}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right font-semibold tabular-nums">{formatMoney(p.payment.amount, p.currency)}</td>
                    <td className="px-4 py-2"><SubmissionBadge status={p.payment.status} /></td>
                    <td className="px-4 py-2">{p.salesAgentId ? profileName(ref, p.salesAgentId) : "—"}</td>
                    <td className="px-4 py-2 text-muted">{profileName(ref, p.payment.submittedById)}</td>
                    <td className="px-4 py-2">
                      {p.payment.hasReceipt && (
                        <a href={`/api/receipts/${p.payment.id}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} aria-label={`Receipt for ${p.customerName}`} className="inline-flex text-navy-700 hover:text-navy-900"><Paperclip size={15} /></a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {open && (
        <Dialog open onClose={() => setOpen(null)} title={`Payment · ${open.customerName}`} description={`${courseOf(ref, open.courseId)?.name ?? "—"}${open.salesAgentId ? ` · sold by ${profileName(ref, open.salesAgentId)}` : ""}`}
          footer={<Button onClick={() => setOpen(null)}>Close</Button>}>
          <SubmissionItem p={open.payment} currency={open.currency} customer={open.customerName} />
        </Dialog>
      )}
    </div>
  );
}

// ── Customers ────────────────────────────────────────────────────────────

type BalanceFilter = "all" | "owing" | "overdue" | "paid";

function CustomersView({ customers }: { customers: AccountingCustomer[] }) {
  const { ref, me, openInquiry } = useWorkspace();
  const [show, setShow] = useState<BalanceFilter>("owing");
  const [sort, setSort] = useState<"overdue" | "balance" | "name" | "next">("overdue");
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const rows = customers
    .filter((c) => (show === "all" || (show === "owing" && c.balance > 0) || (show === "overdue" && c.overdueLeft > 0) || (show === "paid" && c.balance <= 0)))
    .filter((c) => !needle || c.customerName.toLowerCase().includes(needle) || (c.studentName ?? "").toLowerCase().includes(needle))
    .sort((a, b) =>
      sort === "name" ? a.customerName.localeCompare(b.customerName)
      : sort === "balance" ? b.balance - a.balance
      : sort === "next" ? (a.nextDue?.dueOn ?? "9999").localeCompare(b.nextDue?.dueOn ?? "9999")
      : (b.overdueLeft - a.overdueLeft) || (b.balance - a.balance));
  const clickable = me.role === "manager";
  const owed = sumByCurrency(rows.map((c) => ({ amount: c.balance, currency: c.currency })));

  const exportCsv = () => download(`customer-balances-${cairoParts(new Date()).date}.csv`, [
    ["Customer", "Student", "Program", "Course", "Agreed total", "Confirmed paid", "Waiting for review", "Balance left", "Currency", "Next payment date", "Next payment amount", "Next payment status", "Overdue amount", "Overdue since", "Sales agent", "Support agent", "Enrolled on"],
    ...rows.map((c) => [
      c.customerName, c.studentName ?? "", ref.programs.find((x) => x.id === c.programId)?.code ?? "", courseOf(ref, c.courseId)?.name ?? "",
      c.agreed, c.paid, c.pending, c.balance, c.currency, c.nextDue?.dueOn ?? "", c.nextDue?.left ?? "", c.nextDue?.status ?? "", c.overdueLeft, c.overdueSince ?? "",
      c.salesAgentId ? profileName(ref, c.salesAgentId) : "", c.supportOwnerId ? profileName(ref, c.supportOwnerId) : "", c.enrolledAt.slice(0, 10),
    ]),
  ]);

  return (
    <Card>
      <CardHeader title="Customer balances" count={rows.length} subtitle={`As of today · ${moneyList(owed)} still owed by these customers`}
        action={<Button size="sm" icon={<Download size={14} />} onClick={exportCsv} disabled={!rows.length}>Download CSV</Button>} />
      <div className="grid gap-2 border-b border-line p-3 sm:grid-cols-3">
        <label className="relative">
          <span className="sr-only">Search customers</span>
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          <Input className="h-9 pl-8" placeholder="Customer or student" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <Select aria-label="Show" className="h-9" value={show} onChange={(e) => setShow(e.target.value as BalanceFilter)}>
          <option value="owing">With a balance left</option><option value="overdue">With an overdue payment</option><option value="paid">Fully paid</option><option value="all">All customers</option>
        </Select>
        <Select aria-label="Sort by" className="h-9" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="overdue">Most overdue first</option><option value="balance">Largest balance first</option><option value="next">Next payment date</option><option value="name">Name</option>
        </Select>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={<Wallet size={20} />} title="No customers match">Customers appear here once an enrollment is started.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-sm" aria-label="Customer balances">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium">Customer</th><th className="px-4 py-2 font-medium">Course</th><th className="px-4 py-2 text-right font-medium">Agreed</th>
                <th className="px-4 py-2 text-right font-medium">Paid</th><th className="px-4 py-2 text-right font-medium">Balance left</th><th className="px-4 py-2 font-medium">Next payment</th>
                <th className="px-4 py-2 text-right font-medium">Overdue</th><th className="px-4 py-2 font-medium">Sales agent</th><th className="px-4 py-2 font-medium">Support</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((c) => {
                const course = courseOf(ref, c.courseId);
                const type = c.courseTypeId ? ref.courseTypes.find((t) => t.id === c.courseTypeId) : undefined;
                return (
                  <tr key={c.enrollmentId} className={clsx(clickable && "cursor-pointer hover:bg-navy-50/60")} onClick={clickable ? () => openInquiry(c.inquiryId) : undefined} data-customer={c.customerName}>
                    <td className="px-4 py-2"><Name className="font-medium">{c.customerName}</Name>{c.studentName && <span className="block text-xs text-muted">Student: {c.studentName}</span>}</td>
                    <td className="px-4 py-2"><span className="block">{course?.name ?? "—"}</span>{type && <CourseTypeChip type={type} />}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{formatMoney(c.agreed, c.currency)}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{formatMoney(c.paid, c.currency)}{c.pending > 0 && <span className="block text-xs text-warn">+{formatMoney(c.pending, c.currency)} in review</span>}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right font-semibold tabular-nums" data-balance>{formatMoney(c.balance, c.currency)}</td>
                    <td className="px-4 py-2">{c.nextDue ? <span className="flex flex-wrap items-center gap-1.5 whitespace-nowrap">{formatCairo(c.nextDue.dueOn, "date")} · {formatMoney(c.nextDue.left, c.currency)} <DueBadge status={c.nextDue.status} /></span> : <span className="text-muted">—</span>}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{c.overdueLeft > 0 ? <span className="font-medium text-bad">{formatMoney(c.overdueLeft, c.currency)}</span> : <span className="text-muted">—</span>}</td>
                    <td className="px-4 py-2">{c.salesAgentId ? profileName(ref, c.salesAgentId) : "—"}</td>
                    <td className="px-4 py-2 text-muted">{c.supportOwnerId ? profileName(ref, c.supportOwnerId) : c.handedOverAt ? "Waiting" : "Not handed over"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ── Sales agents ─────────────────────────────────────────────────────────

function AgentsView({ payments, customers, range }: { payments: AccountingPayment[]; customers: AccountingCustomer[]; range: { from: string; to: string } }) {
  const { ref } = useWorkspace();
  const confirmed = payments.filter((p) => p.payment.status === "confirmed");
  const agentIds = [...new Set([...confirmed.map((p) => p.salesAgentId), ...customers.filter((c) => c.enrolledAt.slice(0, 10) >= range.from).map((c) => c.salesAgentId)].filter((x): x is string => !!x))];
  const inRange = (iso: string) => {
    const d = cairoParts(new Date(iso)).date;
    return d >= range.from && d <= range.to;
  };
  const rows = agentIds.map((id) => {
    const mine = confirmed.filter((p) => p.salesAgentId === id);
    return {
      id,
      name: profileName(ref, id),
      total: sumByCurrency(mine.map((p) => ({ amount: p.payment.amount, currency: p.currency }))),
      count: mine.length,
      deposits: mine.filter((p) => p.payment.kind === "deposit" || p.payment.kind === "full").length,
      enrollments: customers.filter((c) => c.salesAgentId === id && inRange(c.enrolledAt)).length,
      owed: sumByCurrency(customers.filter((c) => c.salesAgentId === id).map((c) => ({ amount: c.balance, currency: c.currency }))),
    };
  }).sort((a, b) => (b.total[0]?.amount ?? 0) - (a.total[0]?.amount ?? 0));
  const days = daysBetween(range.from, range.to).reverse();
  const showDaily = days.length <= 62 && rows.length > 0;
  const cell = (agent: string, day: string) => sumByCurrency(confirmed.filter((p) => p.salesAgentId === agent && p.payment.paidOn === day).map((p) => ({ amount: p.payment.amount, currency: p.currency })));
  const activeDays = days.filter((d) => confirmed.some((p) => p.payment.paidOn === d));

  const exportCsv = () => download(`sales-agents-${range.from}-to-${range.to}.csv`, [
    ["Sales agent", "Confirmed payments", "Number of payments", "New enrollments", "Still owed by their customers (today)"],
    ...rows.map((r) => [r.name, csvMoney(r.total), r.count, r.enrollments, csvMoney(r.owed)]),
    [],
    ["Day", ...rows.map((r) => r.name)],
    ...activeDays.map((d) => [d, ...rows.map((r) => csvMoney(cell(r.id, d)))]),
  ]);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Sales agents" count={rows.length} subtitle={`Confirmed payments ${formatDay(range.from)} – ${formatDay(range.to)}, credited to the agent who made the sale (later installments included)`}
          action={<Button size="sm" icon={<Download size={14} />} onClick={exportCsv} disabled={!rows.length}>Download CSV</Button>} />
        {rows.length === 0 ? <EmptyState icon={<Banknote size={20} />} title="No confirmed payments">No sales in this period with these filters.</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm" aria-label="Sales agents">
              <thead><tr className="text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium">Sales agent</th><th className="px-4 py-2 text-right font-medium">Confirmed</th><th className="px-4 py-2 text-right font-medium">Payments</th>
                <th className="px-4 py-2 text-right font-medium">New enrollments</th><th className="px-4 py-2 text-right font-medium">Still owed (today)</th>
              </tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id} data-agent={r.name}>
                    <td className="px-4 py-2 font-medium">{r.name}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right font-semibold tabular-nums">{moneyList(r.total)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.count}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.enrollments}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-muted">{moneyList(r.owed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {showDaily && (
        <Card>
          <CardHeader title="Per agent, per day" subtitle={activeDays.length ? "Days with confirmed payments, newest first" : "No confirmed payments on any day in this period"} />
          {activeDays.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="Per agent, per day" style={{ minWidth: 160 + rows.length * 140 }}>
                <thead><tr className="text-left text-xs text-muted"><th className="px-4 py-2 font-medium">Day</th>{rows.map((r) => <th key={r.id} className="px-4 py-2 text-right font-medium">{r.name}</th>)}</tr></thead>
                <tbody className="divide-y divide-line">
                  {activeDays.map((d) => (
                    <tr key={d}>
                      <td className="whitespace-nowrap px-4 py-2">{formatDay(d)}</td>
                      {rows.map((r) => {
                        const v = cell(r.id, d);
                        return <td key={r.id} className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{v.length ? moneyList(v) : <span className="text-muted">—</span>}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
