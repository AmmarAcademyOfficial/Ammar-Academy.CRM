"use client";

import { AlertTriangle, CalendarClock, Clock, Download, GraduationCap, Inbox, Info, UserX, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { Input, Select } from "@/components/ui/form";
import { Card, CardHeader, EmptyState, PageHeader, SkeletonRows, Stat } from "@/components/ui/misc";
import type { LabelCount, MoneyTotal, ReportData } from "@/domain/dto";
import { cairoParts, formatMoney } from "@/domain/rules";
import { formatDay } from "@/features/leads/filters";
import { CourseTypeChip } from "@/features/settings/courses-settings";
import { toCsv } from "@/lib/csv";
import { useApi, useWorkspace } from "@/lib/workspace";

type Preset = "7" | "30" | "90" | "month" | "last_month" | "custom";
const PRESETS: { id: Preset; label: string }[] = [
  { id: "7", label: "Last 7 days" },
  { id: "30", label: "Last 30 days" },
  { id: "90", label: "Last 90 days" },
  { id: "month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "custom", label: "Custom dates" },
];

const shiftDay = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function rangeFor(preset: Preset, today: string, custom: { from: string; to: string }) {
  switch (preset) {
    case "7": case "30": case "90": return { from: shiftDay(today, 1 - Number(preset)), to: today };
    case "month": return { from: `${today.slice(0, 8)}01`, to: today };
    case "last_month": {
      const firstThis = `${today.slice(0, 8)}01`;
      const lastPrev = shiftDay(firstThis, -1);
      return { from: `${lastPrev.slice(0, 8)}01`, to: lastPrev };
    }
    default: return custom;
  }
}

export const fmtMinutes = (m: number | null | undefined) => {
  if (m == null) return "—";
  if (m < 60) return `${Math.round(m)} min`;
  if (m < 60 * 24) return `${(m / 60).toFixed(1)} h`;
  return `${(m / 60 / 24).toFixed(1)} days`;
};
const money = (list: MoneyTotal[]) => (list.length ? list.map((m) => formatMoney(m.amount, m.currency)).join(" · ") : formatMoney(0, "EGP"));
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");

export function ReportsPage() {
  const { ref, now } = useWorkspace();
  const today = cairoParts(now).date;
  const [preset, setPreset] = useState<Preset>("30");
  const [custom, setCustom] = useState({ from: shiftDay(today, -29), to: today });
  const [programId, setProgramId] = useState("");
  const [courseTypeId, setCourseTypeId] = useState("");
  const range = rangeFor(preset, today, custom);
  const valid = !!range.from && !!range.to && range.from <= range.to;
  const qs = new URLSearchParams({ from: range.from, to: range.to, ...(programId ? { program: programId } : {}), ...(courseTypeId ? { courseType: courseTypeId } : {}) });
  const { data, loading, error } = useApi<ReportData>(valid ? `/api/reports?${qs}` : null);
  const program = (id: string) => ref.programs.find((p) => p.id === id)?.code ?? "";

  return (
    <div>
      <PageHeader title="Reports" subtitle="Every figure is calculated in the database and says how it is counted. Dates are Cairo days."
        actions={<Button icon={<Download size={16} />} disabled={!data || !valid} onClick={() => data && downloadCsv(data, { programId, courseTypeId }, ref)}>Download CSV</Button>} />

      <Card className="mb-5 grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4">
        <Select aria-label="Date range" className="h-9" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
          {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </Select>
        {preset === "custom" ? (
          <div className="flex items-center gap-2">
            <Input aria-label="From" type="date" className="h-9 min-w-0" value={custom.from} max={custom.to || today} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            <span className="text-xs text-muted">to</span>
            <Input aria-label="To" type="date" className="h-9 min-w-0" value={custom.to} min={custom.from} max={today} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
          </div>
        ) : (
          <p className="flex items-center px-1 text-sm text-muted">{formatDay(range.from)} – {formatDay(range.to)}</p>
        )}
        <Select aria-label="Program" className="h-9" value={programId} onChange={(e) => setProgramId(e.target.value)}>
          <option value="">All programs</option>
          {ref.programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Select aria-label="Course type" className="h-9" value={courseTypeId} onChange={(e) => setCourseTypeId(e.target.value)}>
          <option value="">All course types</option>
          {ref.courseTypes.map((t) => <option key={t.id} value={t.id}>{t.name}{t.archived ? " (archived)" : ""}</option>)}
        </Select>
      </Card>

      {!valid && <p role="alert" className="mb-4 text-sm text-bad">Choose a start date on or before the end date.</p>}
      {error && <p role="alert" className="mb-4 text-sm text-bad">{error}</p>}
      {!data && loading && <Card><SkeletonRows rows={6} /></Card>}

      {data && valid && (
        <div className={clsx("space-y-5", loading && "opacity-60 transition-opacity")} aria-busy={loading}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="New inquiries" icon={<Inbox size={14} />} value={data.newInquiries} hint={`from ${data.distinctContacts} contacts`} />
            <Stat label="First contact (median)" icon={<Clock size={14} />} value={fmtMinutes(data.firstContact.medianWorkingMinutes)}
              hint={`working time · ${pct(data.firstContact.withinTarget, data.firstContact.measured)} within ${data.firstContactTargetMinutes} min`} />
            <Stat label="Enrollments" icon={<GraduationCap size={14} />} value={data.enrollments} hint={data.additionalEnrollments ? `handed over to support · ${data.additionalEnrollments} additional (existing customers)` : "handed over to support"} tone={data.enrollments ? "ok" : undefined} />
            <Stat label="Confirmed payments" icon={<Wallet size={14} />} value={<span className="text-xl" data-testid="report-confirmed">{money(data.confirmed)}</span>}
              hint={(data.refunds ?? []).length ? `${data.confirmed.reduce((t, c) => t + c.count, 0)} payments, net of ${money(data.refunds ?? [])} refunded${data.withdrawals ? ` · ${data.withdrawals} withdrew` : ""}` : `${data.confirmed.reduce((t, c) => t + c.count, 0)} payments`} />
            <Stat label="Lost" icon={<UserX size={14} />} value={data.lostTotal} hint="closed as Lost in range" />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <DailyBars title="New inquiries per day" days={data.daily} pick="inquiries" unit="inquiries"
              def="Inquiries created on each Cairo day. One parent asking for two children counts as 2 inquiries." />
            <DailyBars title="Enrollments per day" days={data.daily} pick="enrollments" unit="enrollments"
              def="Enrollments handed over to support on each Cairo day (when the qualifying payment was confirmed). One per enrollment, never per installment." />
          </div>

          <Card>
            <CardHeader title="Sales agents" subtitle="Inquiries assigned in the range, and sales credited to the agent who started the enrollment" />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="border-b border-line text-left text-xs text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">Agent</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Assigned</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Contacted</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">First contact (median)</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Now enrolled</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Enrollments</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Confirmed payments</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Open now</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.agents.map((a) => (
                    <tr key={a.userId}>
                      <th scope="row" className="px-4 py-2.5 text-left font-medium">{a.name}{!a.active && <span className="ml-1.5 text-xs font-normal text-muted">(inactive)</span>}</th>
                      <td className="px-3 py-2.5 text-right tabular-nums">{a.assigned}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{a.contacted} <span className="text-xs text-muted">{pct(a.contacted, a.assigned)}</span></td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{fmtMinutes(a.medianWorkingMinutes)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{a.assignedNowEnrolled} <span className="text-xs text-muted">{pct(a.assignedNowEnrolled, a.assigned)}</span></td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{a.enrollments}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{money(a.confirmed)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{a.openNow}</td>
                    </tr>
                  ))}
                  {data.agents.length === 0 && <tr><td colSpan={8} className="px-4 py-6 text-center text-muted">No sales agents yet.</td></tr>}
                </tbody>
              </table>
            </div>
            <HowCounted className="px-4 pb-4" text="Assigned: inquiries whose current owner received them in the range (reassignments count for the new owner). Contacted: of those, how many have a recorded contact attempt — opening Call or WhatsApp alone does not count. First contact: from assignment to the first recorded attempt, counting only the agent's scheduled shift minutes and skipping leave days (agents with no shifts are measured in clock time). Now enrolled: of the inquiries assigned in the range, how many are Enrolled today. Enrollments and Confirmed payments: handovers and manager-confirmed payments in the range, minus refunds recorded in the range, credited to the agent who started the enrollment. Open now: open inquiries owned today, regardless of the range." />
          </Card>

          <Card>
            <CardHeader title="Courses" subtitle={`Inquiries, enrollments and confirmed payments per course · ${data.inquiriesWithoutCourse} new ${data.inquiriesWithoutCourse === 1 ? "inquiry has" : "inquiries have"} no course yet`} />
            {data.courses.length === 0 ? <EmptyState title="No course activity in this range" /> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-sm">
                  <thead className="border-b border-line text-left text-xs text-muted">
                    <tr>
                      <th scope="col" className="px-4 py-2 font-medium">Course</th>
                      <th scope="col" className="px-3 py-2 font-medium">Type</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">New inquiries</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">Enrollments</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Confirmed payments</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.courses.map((c) => {
                      const t = ref.courseTypes.find((x) => x.id === c.courseTypeId);
                      return (
                        <tr key={c.courseId}>
                          <th scope="row" className="px-4 py-2.5 text-left font-medium">{c.name}{!programId && <span className="ml-1.5 text-xs font-normal text-muted">{program(c.programId)}</span>}</th>
                          <td className="px-3 py-2.5">{t ? <CourseTypeChip type={t} /> : "—"}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{c.inquiries}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{c.enrollments}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{money(c.confirmed)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <HowCounted className="px-4 pb-4" text="New inquiries use the course set on the inquiry. Enrollments (handed over in the range) and confirmed payments use the course on the enrollment. The course type filter applies the same way." />
          </Card>

          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            <BarCard title="Enrollments by course type" total={data.enrollments} sub="handed over in range"
              bars={data.courseTypes.map((t) => ({ label: t.name, count: t.enrollments }))}
              def="Enrollments handed over in the range, grouped by the type of the enrolled course." />
            <BarCard title="Inquiries by stage" total={data.newInquiries} sub="current stage of inquiries created in range" bars={data.byStage}
              def="Denominator: inquiries created in the range. Stages are grouped by their fixed meaning, so renaming a stage does not split the report." />
            <BarCard title="Inquiries by source" total={data.newInquiries} sub="created in range" bars={data.bySource}
              def="Which Google Sheet connection, or manual entry, created the inquiry." />
            <BarCard title="Lost reasons" total={data.lostTotal} sub="closed as Lost in range" bars={data.lostReasons}
              def="Inquiries moved to Lost in the range (date basis: time of the Lost stage change), grouped by the required reason." />
            <BarCard title="Overdue follow-ups" total={data.overdueFollowUps} sub="right now, by owner" bars={data.overdueByOwner} tone={data.overdueFollowUps ? "bad" : undefined}
              def="Open sales follow-ups whose due time has passed, as of now. Not affected by the date range." icon={<CalendarClock size={14} aria-hidden />} />
            <Card className="flex flex-col p-4">
              <p className="text-sm font-medium text-muted">Customer support</p>
              <dl className="mt-2 grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-xs text-muted">Handed over</dt><dd className="text-xl font-semibold tabular-nums text-navy-900">{data.support.handedOver}</dd></div>
                <div><dt className="text-xs text-muted">Time to Assign to Me</dt><dd className="text-xl font-semibold tabular-nums text-navy-900">{fmtMinutes(data.support.medianClaimMinutes)}</dd></div>
                <div><dt className="text-xs text-muted">Now Active</dt><dd className="text-xl font-semibold tabular-nums text-navy-900">{data.support.activated}</dd></div>
                <div><dt className="text-xs text-muted">Waiting now</dt><dd className={clsx("text-xl font-semibold tabular-nums", data.awaitingOnboarding ? "text-orange-ink" : "text-navy-900")}>{data.awaitingOnboarding}</dd></div>
              </dl>
              {data.flaggedNow > 0 && <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-warn"><AlertTriangle size={12} aria-hidden /> {data.flaggedNow} flagged after a reversal</p>}
              <HowCounted className="mt-auto pt-3" text="Handed over: onboarding records created in the range. Time to Assign to Me: median from handover to a support member taking the customer (clock time). Now Active: of those, how many are Active. Waiting now and flagged: right now, regardless of the range." />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function HowCounted({ text, className }: { text: string; className?: string }) {
  return (
    <details className={clsx("text-xs text-muted", className)}>
      <summary className="inline-flex cursor-pointer items-center gap-1 font-medium text-navy-700"><Info size={12} aria-hidden /> How it is counted</summary>
      <p className="mt-1.5 max-w-3xl leading-relaxed">{text}</p>
    </details>
  );
}

function BarCard({ title, total, sub, bars, def, tone, icon }: { title: string; total: number; sub: string; bars: LabelCount[]; def: string; tone?: "bad"; icon?: React.ReactNode }) {
  const max = Math.max(1, ...bars.map((b) => b.count));
  const shown = bars.filter((b) => b.count > 0);
  return (
    <Card className="flex flex-col p-4">
      <p className="flex items-center gap-1.5 text-sm font-medium text-muted">{icon}{title}</p>
      <p className={clsx("mt-1 text-2xl font-semibold tabular-nums", tone === "bad" ? "text-bad" : "text-navy-900")}>{total}</p>
      <p className="text-xs text-muted">{sub}</p>
      {shown.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {shown.map((b) => (
            <li key={b.label} className="grid grid-cols-[minmax(0,9rem)_1fr_2.5rem] items-center gap-2 text-xs" title={`${b.label}: ${b.count}`}>
              <span className="truncate" dir="auto">{b.label}</span>
              <span className="h-2 rounded-r bg-navy-50" aria-hidden>
                <span className="block h-2 rounded-r bg-navy-700" style={{ width: `${(b.count / max) * 100}%` }} />
              </span>
              <span className="text-right tabular-nums">{b.count}</span>
            </li>
          ))}
        </ul>
      ) : <p className="mt-3 text-xs text-muted">Nothing in this range.</p>}
      <HowCounted className="mt-auto pt-3" text={def} />
    </Card>
  );
}

/** One series per chart (one axis), bars anchored to the baseline, hover/focus tooltip, and a table fallback. */
function DailyBars({ title, days, pick, unit, def }: { title: string; days: ReportData["daily"]; pick: "inquiries" | "enrollments"; unit: string; def: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = days.map((d) => d[pick]);
  const max = Math.max(1, ...values);
  const total = values.reduce((a, b) => a + b, 0);
  const tick = useMemo(() => Math.max(1, Math.ceil(days.length / 6)), [days.length]);
  const h = hover != null ? days[hover] : null;
  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-muted">{title}</p>
        <p className="text-xs tabular-nums text-muted" aria-live="polite">{h ? `${formatDay(h.day)}: ${h[pick]} ${unit}` : `${total} in total`}</p>
      </div>
      <div className="relative mt-6 h-36" role="img" aria-label={`${title}: ${total} ${unit} over ${days.length} days`}>
        <div className="absolute inset-x-0 top-0 border-t border-dashed border-line" aria-hidden />
        <span className="absolute -top-4 left-0 text-[10px] tabular-nums text-muted" aria-hidden>max {max}</span>
        <div className="absolute inset-0 flex items-end gap-[2px] border-b border-line" onMouseLeave={() => setHover(null)}>
          {days.map((d, i) => (
            <div key={d.day} className="flex h-full min-w-0 flex-1 items-end" onMouseEnter={() => setHover(i)}>
              <div className={clsx("w-full rounded-t-[4px]", hover === i ? "bg-orange-500" : "bg-navy-700")}
                style={{ height: d[pick] ? `${Math.max(3, (d[pick] / max) * 100)}%` : 0 }} />
            </div>
          ))}
        </div>
      </div>
      <div className="relative mt-1 h-3 text-[10px] text-muted" aria-hidden>
        {days.map((d, i) => (i % tick === 0 || i === days.length - 1) && (i === days.length - 1 || days.length - 1 - i >= tick / 2) ? (
          <span key={d.day} className="absolute -translate-x-1/2 whitespace-nowrap first:translate-x-0" style={{ left: `${((i + 0.5) / days.length) * 100}%` }}>
            {formatDay(d.day).replace(/ \d{4}$/, "")}
          </span>
        ) : null)}
      </div>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer font-medium text-navy-700">Show as a table</summary>
        <table className="mt-2 w-full max-w-xs text-xs">
          <tbody>{days.filter((d) => d[pick] > 0).map((d) => <tr key={d.day}><td className="py-0.5">{formatDay(d.day)}</td><td className="text-right tabular-nums">{d[pick]}</td></tr>)}</tbody>
        </table>
        {total === 0 && <p className="mt-1 text-muted">No {unit} in this range.</p>}
      </details>
      <HowCounted className="mt-1" text={def} />
    </Card>
  );
}

// ── CSV export ───────────────────────────────────────────────────────────

function downloadCsv(d: ReportData, f: { programId: string; courseTypeId: string }, ref: ReturnType<typeof useWorkspace>["ref"]) {
  const m = (list: MoneyTotal[]) => list.map((x) => `${x.amount} ${x.currency}`).join(" + ") || "0";
  const rows: unknown[][] = [
    ["Ammar Academy CRM report"],
    ["From", d.range.from, "To", d.range.to],
    ["Program", ref.programs.find((p) => p.id === f.programId)?.name ?? "All programs"],
    ["Course type", ref.courseTypes.find((t) => t.id === f.courseTypeId)?.name ?? "All course types"],
    [],
    ["Summary", "Value"],
    ["New inquiries", d.newInquiries], ["Distinct contacts", d.distinctContacts],
    ["Median first contact (working minutes)", d.firstContact.medianWorkingMinutes ?? ""],
    [`Contacted within ${d.firstContactTargetMinutes} working minutes`, `${d.firstContact.withinTarget} of ${d.firstContact.measured}`],
    ["Enrollments", d.enrollments], ["Confirmed payments", m(d.confirmed)], ["Lost", d.lostTotal],
    ["Overdue follow-ups (now)", d.overdueFollowUps], ["Waiting for support (now)", d.awaitingOnboarding],
    [],
    ["Agent", "Assigned", "Contacted", "Median first contact (working min)", "Now enrolled", "Enrollments", "Confirmed payments", "Open now"],
    ...d.agents.map((a) => [a.name, a.assigned, a.contacted, a.medianWorkingMinutes ?? "", a.assignedNowEnrolled, a.enrollments, m(a.confirmed), a.openNow]),
    [],
    ["Course", "Course type", "New inquiries", "Enrollments", "Confirmed payments"],
    ...d.courses.map((c) => [c.name, ref.courseTypes.find((t) => t.id === c.courseTypeId)?.name ?? "", c.inquiries, c.enrollments, m(c.confirmed)]),
    [],
    ["Day", "New inquiries", "Enrollments"],
    ...d.daily.map((x) => [x.day, x.inquiries, x.enrollments]),
  ];
  const csv = toCsv(rows);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `crm-report-${d.range.from}-to-${d.range.to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
