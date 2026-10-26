"use client";

import { AlertTriangle, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search, SlidersHorizontal, Users, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pill, SupportStatusBadge } from "@/components/ui/badges";
import { Button, IconButton } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { Card, EmptyState, Name, PhoneText, SkeletonRows } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import type { EnrollmentFilters, EnrollmentList, EnrollmentListRow, EnrollmentSortKey, EnrollmentStatus, PaymentState } from "@/domain/dto";
import { cairoParts, formatMoney } from "@/domain/rules";
import { formatDay } from "@/features/leads/filters";
import { CourseTypeChip } from "@/features/settings/courses-settings";
import { profileName } from "@/lib/lead-row";
import { DownloadExcelButton } from "@/lib/download-excel";
import { useApi, useWorkspace } from "@/lib/workspace";

export const EMPTY_ENROLLMENT_FILTERS: EnrollmentFilters = {
  search: "", programIds: [], courseTypeIds: [], courseIds: [], teacherIds: [], salesAgentIds: [], supportOwnerIds: [],
  statuses: [], paymentStates: [], currency: "", enrolledFrom: "", enrolledTo: "", startFrom: "", startTo: "",
};
const STATUS_LABEL: Record<EnrollmentStatus, string> = {
  not_handed_over: "Not handed over yet", new_customer: "New customer", onboarding: "Onboarding", active: "Active", flagged: "Flagged for review",
};
const PAYMENT_LABEL: Record<PaymentState, string> = {
  paid: "Fully paid", balance: "Balance left", overdue: "Overdue", pending: "Payment waiting for review", none: "No payment yet",
};
const PAGE_SIZE = 50;
const STORE_KEY = "crm.enrollments.filters.v1";

/** How many filters are set (search not counted). */
export function enrollmentFilterCount(f: EnrollmentFilters): number {
  return f.programIds.length + f.courseTypeIds.length + f.courseIds.length + f.teacherIds.length + f.salesAgentIds.length +
    f.supportOwnerIds.length + f.statuses.length + f.paymentStates.length + (f.currency ? 1 : 0) +
    (f.enrolledFrom || f.enrolledTo ? 1 : 0) + (f.startFrom || f.startTo ? 1 : 0);
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function loadStored(): EnrollmentFilters {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? { ...EMPTY_ENROLLMENT_FILTERS, ...JSON.parse(raw) } : EMPTY_ENROLLMENT_FILTERS;
  } catch {
    return EMPTY_ENROLLMENT_FILTERS;
  }
}

function StatusCell({ s }: { s: EnrollmentStatus }) {
  if (s === "flagged") return <Pill className="bg-bad-bg text-bad" icon={<AlertTriangle size={12} />}>Flagged</Pill>;
  if (s === "not_handed_over") return <Pill className="bg-[#eeeff3] text-[#4b4e66]">Not handed over</Pill>;
  return <SupportStatusBadge status={s} />;
}

/**
 * Every enrolled customer, one row per enrollment, with filters that combine (managers, accountants,
 * support). Embedded in Support → Customers and Accounting → Customers.
 */
export function EnrollmentsView() {
  const { me, ref, now, openInquiry } = useWorkspace();
  const [filters, setFilters] = useState<EnrollmentFilters>(EMPTY_ENROLLMENT_FILTERS);
  const [restored, setRestored] = useState(false);
  const [scope, setScope] = useState<"mine" | "all">(me.role === "support" ? "mine" : "all");
  const [sort, setSort] = useState<{ key: EnrollmentSortKey; dir: "asc" | "desc" }>({ key: "enrolled", dir: "desc" });
  const [page, setPage] = useState(0);
  const [dialog, setDialog] = useState(false);
  const search = useDebounced(filters.search, 300);

  // Remember the last filters in this browser (a convenience only; the list works without it).
  // Read after mount (not during render), so the server and the browser render the same first page.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setFilters(loadStored()); setRestored(true); }, []);
  useEffect(() => {
    if (!restored) return;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(filters)); } catch { /* storage unavailable */ }
  }, [filters, restored]);

  const q = useMemo(() => ({ filters: { ...filters, search }, scope: me.role === "support" ? scope : undefined, sort, page, pageSize: PAGE_SIZE }), [filters, search, scope, sort, page, me.role]);
  const { data, loading, error } = useApi<EnrollmentList>(restored ? `/api/enrollments?q=${encodeURIComponent(JSON.stringify(q))}` : null);
  const count = enrollmentFilterCount(filters);
  const apply = (f: EnrollmentFilters) => { setFilters(f); setPage(0); };
  const toggleSort = (key: EnrollmentSortKey) => { setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "customer" || key === "course" ? "asc" : "desc" })); setPage(0); };
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  const today = cairoParts(now).date;
  const course = (id: string) => ref.courses.find((c) => c.id === id);
  const showPhone = me.role !== "accountant";
  const canDownload = me.role === "manager" || me.role === "accountant";
  const sp = { sort, onSort: toggleSort };


  return (
    <div>
      {data && data.totals.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2" data-testid="enrollment-totals">
          {data.totals.map((t) => (
            <Card key={t.currency} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
              <span className="font-semibold">{t.count} customer{t.count === 1 ? "" : "s"} · {t.currency}</span>
              <span>Paid <b className="font-semibold tabular-nums">{formatMoney(t.paid, t.currency)}</b></span>
              <span>Balance left <b className="font-semibold tabular-nums">{formatMoney(t.balance, t.currency)}</b></span>
              {t.overdue > 0 && <span className="text-bad">Overdue <b className="font-semibold tabular-nums">{formatMoney(t.overdue, t.currency)}</b></span>}
            </Card>
          ))}
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div className="relative min-w-[200px] flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <Input type="search" aria-label="Search customers" placeholder={showPhone ? "Search name, student or phone" : "Search name or student"} value={filters.search}
              onChange={(e) => apply({ ...filters, search: e.target.value })} className="pl-9" />
          </div>
          {me.role === "support" && (
            <div role="tablist" aria-label="Whose customers" className="flex gap-1">
              {(["mine", "all"] as const).map((s) => (
                <button key={s} role="tab" aria-selected={scope === s} onClick={() => { setScope(s); setPage(0); }}
                  className={clsx("h-9 rounded-full px-3 text-sm font-medium", scope === s ? "bg-navy-900 text-white" : "border border-line bg-white hover:bg-navy-50")}>
                  {s === "mine" ? "Mine and the queue" : "All customers"}
                </button>
              ))}
            </div>
          )}
          <Button icon={<SlidersHorizontal size={16} />} onClick={() => setDialog(true)}>Filters{count ? ` · ${count}` : ""}</Button>
          {canDownload && <DownloadExcelButton url="/api/enrollments/export" body={{ filters: { ...filters, search }, sort }} disabled={!data?.total} />}
        </div>
        {(count > 0 || filters.search) && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5 text-sm">
            <span className="font-medium" data-testid="enrollment-count">{data ? `${data.total} matching` : "…"}</span>
            <Chips f={filters} onChange={apply} />
            <button className="ml-auto text-xs font-medium text-navy-700 hover:underline" onClick={() => apply({ ...EMPTY_ENROLLMENT_FILTERS })}>Clear filters</button>
          </div>
        )}
        {error && <p role="alert" className="border-b border-line bg-bad-bg px-4 py-2 text-sm text-bad">{error}</p>}

        {!data && loading ? <SkeletonRows rows={6} /> : !data ? null : data.rows.length === 0 ? (
          <EmptyState icon={<Users size={22} />} title={count || filters.search ? "No customers match these filters" : "No customers yet"}
            action={count || filters.search ? <Button onClick={() => apply({ ...EMPTY_ENROLLMENT_FILTERS })}>Clear filters</Button> : undefined}>
            {count || filters.search ? "Try removing a filter." : "Customers appear here once they enroll."}
          </EmptyState>
        ) : (
          <div className={clsx(loading && "opacity-60 transition-opacity")}>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-left text-sm" aria-label="Customers">
                <thead>
                  <tr className="border-b border-line text-xs text-muted">
                    <Th k="customer" {...sp}>Customer</Th><Th k="course" {...sp}>Course</Th><Th k="enrolled" {...sp}>Enrolled</Th><Th k="sales" {...sp}>Sales · support</Th>
                    <Th {...sp}>Status</Th><Th k="paid" right {...sp}>Paid</Th><Th k="balance" right {...sp}>Balance</Th><Th k="next_due" {...sp}>Next due</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.enrollmentId} className="cursor-pointer border-b border-line/70 last:border-0 hover:bg-navy-50/60" onClick={() => openInquiry(r.inquiryId)} data-customer={r.customerName}>
                      <td className="max-w-[200px] px-3 py-2.5 pl-5">
                        <button className="block w-full text-left" onClick={(e) => { e.stopPropagation(); openInquiry(r.inquiryId); }}>
                          <Name className="block truncate font-medium">{r.customerName}</Name>
                          <span className="block truncate text-xs text-muted">{r.studentName && r.studentName !== r.customerName ? `Student: ${r.studentName}` : ""}{r.phone && <PhoneText value={r.phone} className={r.studentName && r.studentName !== r.customerName ? "ml-2" : ""} />}</span>
                        </button>
                      </td>
                      <td className="max-w-[220px] px-3 py-2.5">
                        <span className="block truncate">{course(r.courseId)?.name ?? "—"}</span>
                        <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted"><CourseTypeChip type={ref.courseTypes.find((t) => t.id === r.courseTypeId)} />{r.courseStart && <span className="whitespace-nowrap">starts {formatDay(r.courseStart)}</span>}</span>
                        {(r.teacherNames || r.packageHours !== null) && (
                          <span className="block truncate text-xs text-muted">{r.teacherNames ? `Teacher: ${r.teacherNames}` : ""}{r.packageHours !== null ? `${r.teacherNames ? " · " : ""}${r.packageUsed ?? 0} of ${r.packageHours} h used` : ""}</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{formatDay(r.enrolledAt.slice(0, 10))}</td>
                      <td className="max-w-[150px] px-3 py-2.5 text-xs">
                        <span className="block truncate">{r.salesAgentId ? profileName(ref, r.salesAgentId) : <span className="text-muted">No sales agent</span>}</span>
                        <span className="block truncate text-muted">{r.supportOwnerId ? profileName(ref, r.supportOwnerId) : r.status === "not_handed_over" ? "Not with support yet" : "Unclaimed"}</span>
                      </td>
                      <td className="px-3 py-2.5"><StatusCell s={r.status} /></td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{formatMoney(r.paid, r.currency)}<span className="block text-xs text-muted">of {formatMoney(r.agreed, r.currency)}</span></td>
                      <td className={clsx("whitespace-nowrap px-3 py-2.5 text-right font-medium tabular-nums", r.balance === 0 && "text-ok")}>
                        {r.balance === 0 ? "Paid" : formatMoney(r.balance, r.currency)}
                        {r.pending > 0 && <span className="block text-xs font-normal text-warn">{formatMoney(r.pending, r.currency)} to review</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 pr-5 text-xs">
                        {r.overdueLeft > 0 ? <span className="font-medium text-bad">{formatMoney(r.overdueLeft, r.currency)}<span className="block font-normal">overdue</span></span>
                          : r.nextDueOn ? <>{formatMoney(r.nextDueLeft ?? 0, r.currency)}<span className="block text-muted">{r.nextDueOn < today ? "was due" : "due"} {formatDay(r.nextDueOn)}</span></> : <span className="text-muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-line lg:hidden" aria-label="Customers">
              {data.rows.map((r) => <MobileRow key={r.enrollmentId} r={r} onOpen={() => openInquiry(r.inquiryId)} />)}
            </ul>
            <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-sm text-muted">
              <span>{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, data.total)} of {data.total}</span>
              <div className="flex items-center gap-1">
                <IconButton label="Previous page" icon={<ChevronLeft size={18} />} disabled={page === 0} onClick={() => setPage(page - 1)} />
                <span className="px-1 text-xs">Page {page + 1} of {pages}</span>
                <IconButton label="Next page" icon={<ChevronRight size={18} />} disabled={page >= pages - 1} onClick={() => setPage(page + 1)} />
              </div>
            </div>
          </div>
        )}
      </Card>
      {dialog && <FiltersDialog value={filters} onClose={() => setDialog(false)} onApply={(f) => { apply(f); setDialog(false); }} />}
    </div>
  );
}

function Th({ k, children, right, sort, onSort }: { k?: EnrollmentSortKey; children: string; right?: boolean; sort: { key: EnrollmentSortKey; dir: "asc" | "desc" }; onSort: (k: EnrollmentSortKey) => void }) {
  return (
    <th scope="col" className={clsx("whitespace-nowrap px-3 py-2.5 font-medium first:pl-5", right && "text-right")} aria-sort={k && sort.key === k ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
      {k ? (
        <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => onSort(k)}>
          {children}{sort.key === k && (sort.dir === "asc" ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />)}
        </button>
      ) : children}
    </th>
  );
}

function MobileRow({ r, onOpen }: { r: EnrollmentListRow; onOpen: () => void }) {
  const { ref } = useWorkspace();
  return (
    <li data-customer={r.customerName}>
      <button className="flex w-full flex-col gap-1 px-4 py-3 text-left" onClick={onOpen}>
        <span className="flex w-full items-center justify-between gap-2">
          <Name className="truncate font-medium">{r.customerName}</Name>
          <StatusCell s={r.status} />
        </span>
        <span className="truncate text-xs text-muted">{ref.courses.find((c) => c.id === r.courseId)?.name ?? "—"} · enrolled {formatDay(r.enrolledAt.slice(0, 10))}</span>
        <span className="flex flex-wrap gap-x-3 text-xs">
          <span>Paid {formatMoney(r.paid, r.currency)} of {formatMoney(r.agreed, r.currency)}</span>
          {r.overdueLeft > 0 ? <span className="font-medium text-bad">{formatMoney(r.overdueLeft, r.currency)}<span className="block font-normal">overdue</span></span> : r.balance === 0 ? <span className="text-ok">Fully paid</span> : null}
        </span>
      </button>
    </li>
  );
}

/** The active filters as removable chips. */
function Chips({ f, onChange }: { f: EnrollmentFilters; onChange: (f: EnrollmentFilters) => void }) {
  const { ref } = useWorkspace();
  const chips: { label: string; clear: () => EnrollmentFilters }[] = [];
  const person = (id: string) => (id === "none" ? "None" : profileName(ref, id));
  const list = <K extends keyof EnrollmentFilters>(key: K, label: (v: string) => string, prefix: string) => {
    for (const v of f[key] as string[]) chips.push({ label: `${prefix}: ${label(v)}`, clear: () => ({ ...f, [key]: (f[key] as string[]).filter((x) => x !== v) }) });
  };
  list("programIds", (v) => ref.programs.find((p) => p.id === v)?.name ?? "?", "Program");
  list("courseTypeIds", (v) => ref.courseTypes.find((t) => t.id === v)?.name ?? "?", "Type");
  list("courseIds", (v) => ref.courses.find((c) => c.id === v)?.name ?? "?", "Course");
  list("salesAgentIds", person, "Sales");
  list("supportOwnerIds", person, "Support");
  list("teacherIds", (v) => ref.teachers.find((t) => t.id === v)?.fullName ?? "?", "Teacher");
  list("statuses", (v) => STATUS_LABEL[v as EnrollmentStatus], "Status");
  list("paymentStates", (v) => PAYMENT_LABEL[v as PaymentState], "Payments");
  if (f.currency) chips.push({ label: `Currency: ${f.currency}`, clear: () => ({ ...f, currency: "" }) });
  const range = (a: string, b: string) => (a && b ? `${formatDay(a)} – ${formatDay(b)}` : a ? `from ${formatDay(a)}` : `until ${formatDay(b)}`);
  if (f.enrolledFrom || f.enrolledTo) chips.push({ label: `Enrolled: ${range(f.enrolledFrom, f.enrolledTo)}`, clear: () => ({ ...f, enrolledFrom: "", enrolledTo: "" }) });
  if (f.startFrom || f.startTo) chips.push({ label: `Course starts: ${range(f.startFrom, f.startTo)}`, clear: () => ({ ...f, startFrom: "", startTo: "" }) });
  return (
    <>
      {chips.map((c) => (
        <span key={c.label} className="inline-flex items-center gap-1 rounded-full border border-line bg-white py-0.5 pl-2.5 pr-1 text-xs">
          {c.label}
          <button aria-label={`Remove filter ${c.label}`} className="rounded-full p-0.5 hover:bg-navy-50" onClick={() => onChange(c.clear())}><X size={12} /></button>
        </span>
      ))}
    </>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{title}</legend>
      {children}
    </fieldset>
  );
}

function FiltersDialog({ value, onApply, onClose }: { value: EnrollmentFilters; onApply: (f: EnrollmentFilters) => void; onClose: () => void }) {
  const { ref, now } = useWorkspace();
  const [f, setF] = useState<EnrollmentFilters>(value);
  const today = cairoParts(now).date;
  const toggle = <K extends keyof EnrollmentFilters>(key: K, v: string) =>
    setF({ ...f, [key]: (f[key] as string[]).includes(v) ? (f[key] as string[]).filter((x) => x !== v) : [...(f[key] as string[]), v] });
  const has = (key: keyof EnrollmentFilters, v: string) => (f[key] as string[]).includes(v);
  const courses = ref.courses.filter((c) => (!f.programIds.length || f.programIds.includes(c.programId)) && (!f.courseTypeIds.length || (c.courseTypeId && f.courseTypeIds.includes(c.courseTypeId))));
  const sales = ref.profiles.filter((p) => p.role === "sales" || p.role === "manager");
  const support = ref.profiles.filter((p) => p.role === "support");
  const monthStart = `${today.slice(0, 8)}01`;
  const bad = (a: string, b: string) => (a && b && a > b ? "The start date is after the end date." : undefined);
  return (
    <Dialog open onClose={onClose} title="Filter customers" description="Every filter you set must match. Within one group, any ticked option matches." className="max-w-3xl"
      footer={<>
        <Button className="mr-auto" variant="ghost" onClick={() => setF({ ...EMPTY_ENROLLMENT_FILTERS, search: f.search })}>Clear filters</Button>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!!bad(f.enrolledFrom, f.enrolledTo) || !!bad(f.startFrom, f.startTo)} onClick={() => onApply(f)}>Show customers</Button>
      </>}>
      <div className="grid gap-6 sm:grid-cols-2">
        <fieldset className="grid gap-3 rounded-xl border border-line p-4 sm:col-span-2 sm:grid-cols-2 [&>*]:min-w-0">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Dates</legend>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Enrolled from" error={bad(f.enrolledFrom, f.enrolledTo)}>{(p) => <Input type="date" value={f.enrolledFrom} onChange={(e) => setF({ ...f, enrolledFrom: e.target.value })} {...p} />}</Field>
            <Field label="Enrolled to">{(p) => <Input type="date" value={f.enrolledTo} onChange={(e) => setF({ ...f, enrolledTo: e.target.value })} {...p} />}</Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Course starts from" error={bad(f.startFrom, f.startTo)}>{(p) => <Input type="date" value={f.startFrom} onChange={(e) => setF({ ...f, startFrom: e.target.value })} {...p} />}</Field>
            <Field label="Course starts to">{(p) => <Input type="date" value={f.startTo} onChange={(e) => setF({ ...f, startTo: e.target.value })} {...p} />}</Field>
          </div>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            {([["Enrolled this month", monthStart, today], ["Enrolled last 30 days", new Date(Date.parse(`${today}T12:00:00Z`) - 29 * 864e5).toISOString().slice(0, 10), today]] as const).map(([label, a, b]) => (
              <button key={label} type="button" aria-pressed={f.enrolledFrom === a && f.enrolledTo === b} onClick={() => setF({ ...f, enrolledFrom: a, enrolledTo: b })}
                className={clsx("h-8 rounded-md border px-2.5 text-xs", f.enrolledFrom === a && f.enrolledTo === b ? "border-navy-900 bg-navy-50 font-semibold" : "border-line hover:bg-navy-50")}>{label}</button>
            ))}
          </div>
        </fieldset>
        <Group title="Program">{ref.programs.map((p) => <Checkbox key={p.id} label={p.name} checked={has("programIds", p.id)} onChange={() => toggle("programIds", p.id)} />)}</Group>
        <Group title="Course type">{ref.courseTypes.filter((t) => !t.archived).map((t) => <Checkbox key={t.id} label={t.name} checked={has("courseTypeIds", t.id)} onChange={() => toggle("courseTypeIds", t.id)} />)}</Group>
        <Group title="Course"><div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">{courses.map((c) => <Checkbox key={c.id} label={c.name} checked={has("courseIds", c.id)} onChange={() => toggle("courseIds", c.id)} />)}</div></Group>
        <Group title="Status">{(Object.keys(STATUS_LABEL) as EnrollmentStatus[]).map((s) => <Checkbox key={s} label={STATUS_LABEL[s]} checked={has("statuses", s)} onChange={() => toggle("statuses", s)} />)}</Group>
        <Group title="Payments">{(Object.keys(PAYMENT_LABEL) as PaymentState[]).map((s) => <Checkbox key={s} label={PAYMENT_LABEL[s]} checked={has("paymentStates", s)} onChange={() => toggle("paymentStates", s)} />)}</Group>
        <Group title="Sales agent (who made the sale)">
          <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
            {sales.map((p) => <Checkbox key={p.id} label={p.fullName} checked={has("salesAgentIds", p.id)} onChange={() => toggle("salesAgentIds", p.id)} />)}
            <Checkbox label="No sales agent" checked={has("salesAgentIds", "none")} onChange={() => toggle("salesAgentIds", "none")} />
          </div>
        </Group>
        <Group title="Support owner">
          {support.map((p) => <Checkbox key={p.id} label={p.fullName} checked={has("supportOwnerIds", p.id)} onChange={() => toggle("supportOwnerIds", p.id)} />)}
          <Checkbox label="No support owner (unclaimed)" checked={has("supportOwnerIds", "none")} onChange={() => toggle("supportOwnerIds", "none")} />
        </Group>
        {ref.teachers.length > 0 && (
          <Group title="Teacher"><div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">{ref.teachers.map((t) => <Checkbox key={t.id} label={t.fullName} checked={has("teacherIds", t.id)} onChange={() => toggle("teacherIds", t.id)} />)}</div></Group>
        )}
        <Group title="Currency">
          <Select aria-label="Currency" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
            <option value="">Any currency</option><option value="EGP">EGP</option><option value="USD">USD</option>
          </Select>
        </Group>
      </div>
    </Dialog>
  );
}
