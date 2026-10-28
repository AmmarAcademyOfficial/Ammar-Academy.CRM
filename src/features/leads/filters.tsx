"use client";

import { cn as clsx } from "@/components/ui/cn";
import { X } from "lucide-react";
import { useState } from "react";
import { TAG_COLORS } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { SearchChecklist } from "@/components/ui/search-select";
import { Dialog } from "@/components/ui/overlay";
import { cairoParts } from "@/domain/rules";
import type { DateFilterField, LeadFilters, TagColor } from "@/domain/types";
import { EMPTY_FILTERS } from "@/domain/filters";
import { useWorkspace } from "@/lib/workspace";

const FOLLOWUP_LABEL: Record<LeadFilters["followUp"], string> = {
  any: "Any",
  today: "Due today",
  overdue: "Overdue",
  upcoming: "Upcoming",
  none: "No follow-up set",
};

export const DATE_FIELD_LABEL: Record<DateFilterField, string> = {
  created: "Created",
  assigned: "Assigned",
  followUp: "Next follow-up",
  lastContact: "Latest contact",
};

/** Shifts a "YYYY-MM-DD" calendar date by whole days. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "14 Oct 2026" for a "YYYY-MM-DD" calendar date. */
export function formatDay(date: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

export function dateRangeLabel(f: LeadFilters): string {
  const field = DATE_FIELD_LABEL[f.dateField];
  if (f.dateFrom && f.dateTo) return f.dateFrom === f.dateTo ? `${field}: ${formatDay(f.dateFrom)}` : `${field}: ${formatDay(f.dateFrom)} – ${formatDay(f.dateTo)}`;
  if (f.dateFrom) return `${field}: from ${formatDay(f.dateFrom)}`;
  return `${field}: until ${formatDay(f.dateTo)}`;
}

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</legend>
      {/* More than 7 choices: a search box (ticked ones stay visible). */}
      <SearchChecklist label={title}>{children}</SearchChecklist>
    </fieldset>
  );
}

export function FilterDialog({ value, onApply, onClose }: { value: LeadFilters; onApply: (f: LeadFilters) => void; onClose: () => void }) {
  const { ref: db, me, now } = useWorkspace();
  const [f, setF] = useState<LeadFilters>(value);
  const tags = db.tags.filter((t) => !t.archived);
  const today = cairoParts(now).date;
  const rangeError = f.dateFrom && f.dateTo && f.dateFrom > f.dateTo ? "The start date is after the end date." : undefined;
  const preset = (from: string, to: string) => setF({ ...f, dateFrom: from, dateTo: to });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Filters"
      className="max-w-2xl"
      footer={
        <>
          <Button className="mr-auto" variant="ghost" onClick={() => setF({ ...EMPTY_FILTERS, search: f.search })}>Clear filters</Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!!rangeError} onClick={() => onApply(f)}>Show results</Button>
        </>
      }
    >
      <div className="grid gap-6 sm:grid-cols-2">
        <fieldset className="rounded-xl border border-line p-4 sm:col-span-2">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Date range</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Date of">
              {(p) => (
                <Select value={f.dateField} onChange={(e) => setF({ ...f, dateField: e.target.value as DateFilterField })} {...p}>
                  {(Object.keys(DATE_FIELD_LABEL) as DateFilterField[]).map((k) => (
                    <option key={k} value={k}>{DATE_FIELD_LABEL[k]}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="From" error={rangeError}>
              {(p) => <Input type="date" value={f.dateFrom} max={f.dateTo || undefined} onChange={(e) => setF({ ...f, dateFrom: e.target.value })} {...p} />}
            </Field>
            <Field label="To (inclusive)">
              {(p) => <Input type="date" value={f.dateTo} min={f.dateFrom || undefined} onChange={(e) => setF({ ...f, dateTo: e.target.value })} {...p} />}
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {[
              ["Today", today, today],
              ["Yesterday", addDays(today, -1), addDays(today, -1)],
              ["Last 7 days", addDays(today, -6), today],
              ["Last 30 days", addDays(today, -29), today],
              ["This month", today.slice(0, 8) + "01", today],
            ].map(([label, from, to]) => (
              <button
                key={label}
                type="button"
                aria-pressed={f.dateFrom === from && f.dateTo === to}
                onClick={() => preset(from, to)}
                className={clsx("h-8 rounded-md border px-2.5 text-xs", f.dateFrom === from && f.dateTo === to ? "border-navy-900 bg-navy-50 font-semibold" : "border-line hover:bg-navy-50")}
              >
                {label}
              </button>
            ))}
            {(f.dateFrom || f.dateTo) && (
              <button type="button" onClick={() => preset("", "")} className="h-8 px-2 text-xs font-medium text-navy-700 hover:underline">
                Clear dates
              </button>
            )}
          </div>
          <p className="mt-2 text-xs text-muted">Dates are Cairo calendar days. Leave either side empty for an open range.</p>
        </fieldset>
        <Group title="Program">
          {db.programs.map((p) => (
            <Checkbox key={p.id} label={p.name} checked={f.programIds.includes(p.id)} onChange={() => setF({ ...f, programIds: toggle(f.programIds, p.id) })} />
          ))}
        </Group>
        <Group title="Follow-up">
          {(Object.keys(FOLLOWUP_LABEL) as LeadFilters["followUp"][]).map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="radio" name="fu" checked={f.followUp === k} onChange={() => setF({ ...f, followUp: k })} className="accent-navy-900" />
              {FOLLOWUP_LABEL[k]}
            </label>
          ))}
          <Checkbox label="Not yet contacted" checked={f.uncontactedOnly} onChange={(v) => setF({ ...f, uncontactedOnly: v })} />
          <Checkbox label="New, not opened yet" checked={!!f.unopenedOnly} onChange={(v) => setF({ ...f, unopenedOnly: v })} />
        </Group>
        <Group title="Course type">
          {db.courseTypes.filter((t) => !t.archived).map((t) => (
            <Checkbox key={t.id} label={t.name} checked={(f.courseTypeIds ?? []).includes(t.id)} onChange={() => setF({ ...f, courseTypeIds: toggle(f.courseTypeIds ?? [], t.id) })} />
          ))}
        </Group>
        <Group title="Course">
          <Checkbox label="No course yet" checked={(f.courseIds ?? []).includes("none")} onChange={() => setF({ ...f, courseIds: toggle(f.courseIds ?? [], "none") })} />
          {db.courses
            .filter((c) => (f.programIds.length === 0 || f.programIds.includes(c.programId)) && ((f.courseTypeIds ?? []).length === 0 || (f.courseTypeIds ?? []).includes(c.courseTypeId ?? "")))
            .map((c) => (
              <Checkbox key={c.id} label={`${c.name}${c.active ? "" : " (closed)"}`} checked={(f.courseIds ?? []).includes(c.id)} onChange={() => setF({ ...f, courseIds: toggle(f.courseIds ?? [], c.id) })} />
            ))}
        </Group>
        <Group title="Stage">
          {db.stages.map((s) => (
            <Checkbox key={s.id} label={s.label} checked={f.stageKeys.includes(s.systemKey)} onChange={() => setF({ ...f, stageKeys: toggle(f.stageKeys, s.systemKey) })} />
          ))}
        </Group>
        <Group title="Last outcome">
          {db.outcomes.map((o) => (
            <Checkbox key={o.id} label={o.label} checked={f.outcomeIds.includes(o.id)} onChange={() => setF({ ...f, outcomeIds: toggle(f.outcomeIds, o.id) })} />
          ))}
        </Group>
        <Group title="Tags">
          {tags.map((t) => (
            <Checkbox
              key={t.id}
              label={<span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: TAG_COLORS[t.color].dot }} aria-hidden />{t.name}</span>}
              checked={f.tagIds.includes(t.id)}
              onChange={() => setF({ ...f, tagIds: toggle(f.tagIds, t.id) })}
            />
          ))}
        </Group>
        <Group title="Primary label color">
          <div className="flex flex-wrap gap-2">
            {(Object.keys(TAG_COLORS) as TagColor[]).map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={f.primaryColors.includes(c)}
                onClick={() => setF({ ...f, primaryColors: toggle(f.primaryColors, c) })}
                className={clsx("inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs", f.primaryColors.includes(c) ? "border-navy-900 bg-navy-50 font-semibold" : "border-line")}
              >
                <span className="h-3 w-3 rounded-full" style={{ background: TAG_COLORS[c].dot }} aria-hidden />
                {TAG_COLORS[c].label}
              </button>
            ))}
          </div>
        </Group>
        {me.role === "manager" && (
          <Group title="Owner">
            <Checkbox label="Unassigned" checked={f.ownerIds.includes("unassigned")} onChange={() => setF({ ...f, ownerIds: toggle(f.ownerIds, "unassigned") })} />
            {db.profiles.filter((p) => p.role === "sales").map((p) => (
              <Checkbox key={p.id} label={`${p.fullName}${p.active ? "" : " (inactive)"}`} checked={f.ownerIds.includes(p.id)} onChange={() => setF({ ...f, ownerIds: toggle(f.ownerIds, p.id) })} />
            ))}
          </Group>
        )}
      </div>
    </Dialog>
  );
}

/** Removable chips for every active filter. */
export function FilterChips({ value, onChange }: { value: LeadFilters; onChange: (f: LeadFilters) => void }) {
  const { ref: db, me } = useWorkspace();
  const chips: { label: string; remove: () => void }[] = [];
  value.programIds.forEach((id) => chips.push({ label: `Program: ${db.programs.find((p) => p.id === id)?.code}`, remove: () => onChange({ ...value, programIds: value.programIds.filter((x) => x !== id) }) }));
  value.stageKeys.forEach((k) => chips.push({ label: `Stage: ${db.stages.find((s) => s.systemKey === k)?.label}`, remove: () => onChange({ ...value, stageKeys: value.stageKeys.filter((x) => x !== k) }) }));
  value.outcomeIds.forEach((id) => chips.push({ label: `Outcome: ${db.outcomes.find((o) => o.id === id)?.label}`, remove: () => onChange({ ...value, outcomeIds: value.outcomeIds.filter((x) => x !== id) }) }));
  (value.courseTypeIds ?? []).forEach((id) => chips.push({ label: `Course type: ${db.courseTypes.find((t) => t.id === id)?.name}`, remove: () => onChange({ ...value, courseTypeIds: value.courseTypeIds.filter((x) => x !== id) }) }));
  (value.courseIds ?? []).forEach((id) => chips.push({ label: `Course: ${id === "none" ? "None yet" : db.courses.find((c) => c.id === id)?.name}`, remove: () => onChange({ ...value, courseIds: value.courseIds.filter((x) => x !== id) }) }));
  value.tagIds.forEach((id) => chips.push({ label: `Tag: ${db.tags.find((t) => t.id === id)?.name}`, remove: () => onChange({ ...value, tagIds: value.tagIds.filter((x) => x !== id) }) }));
  value.primaryColors.forEach((c) => chips.push({ label: `Label color: ${TAG_COLORS[c].label}`, remove: () => onChange({ ...value, primaryColors: value.primaryColors.filter((x) => x !== c) }) }));
  if (me.role === "manager")
    value.ownerIds.forEach((id) => chips.push({ label: `Owner: ${id === "unassigned" ? "Unassigned" : db.profiles.find((p) => p.id === id)?.fullName}`, remove: () => onChange({ ...value, ownerIds: value.ownerIds.filter((x) => x !== id) }) }));
  if (value.followUp !== "any") chips.push({ label: `Follow-up: ${FOLLOWUP_LABEL[value.followUp]}`, remove: () => onChange({ ...value, followUp: "any" }) });
  if (value.dateFrom || value.dateTo) chips.push({ label: dateRangeLabel(value), remove: () => onChange({ ...value, dateFrom: "", dateTo: "" }) });
  if (value.uncontactedOnly) chips.push({ label: "Not yet contacted", remove: () => onChange({ ...value, uncontactedOnly: false }) });
  if (value.unopenedOnly) chips.push({ label: "New, not opened yet", remove: () => onChange({ ...value, unopenedOnly: false }) });
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <span key={c.label} className="inline-flex h-7 items-center gap-1 rounded-full border border-navy-100 bg-navy-50 pl-3 pr-1 text-xs font-medium text-navy-800">
          {c.label}
          <button onClick={c.remove} aria-label={`Remove filter ${c.label}`} className="rounded-full p-1 hover:bg-navy-100">
            <X size={12} />
          </button>
        </span>
      ))}
      <button onClick={() => onChange({ ...EMPTY_FILTERS, search: value.search, ownerIds: me.role === "manager" ? [] : value.ownerIds })} className="text-xs font-semibold text-navy-700 hover:underline">
        Clear Filters
      </button>
    </div>
  );
}
