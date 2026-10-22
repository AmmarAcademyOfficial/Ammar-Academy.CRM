"use client";

import { Archive, ArchiveRestore, GraduationCap, Pencil, Plus, UserPlus, Users } from "lucide-react";
import { useState } from "react";
import { Button, IconButton } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { Checkbox, Field, Input, Select, Textarea, Toggle } from "@/components/ui/form";
import { Card, CardHeader, EmptyState } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import { academyMonth, shiftDay } from "@/domain/accounting";
import type { Settings, Teacher, TeacherAssignment, TeacherRate } from "@/domain/types";
import { cairoParts, formatMoney } from "@/domain/rules";
import { formatDay } from "@/features/leads/filters";
import { useRunAction } from "@/lib/run-action";
import { useApi, useWorkspace } from "@/lib/workspace";
import { updateSettings } from "@/server/actions";
import { addTeacherRate, assignTeacher, endTeacherAssignment, saveTeacher, setTeacherRateAmount, setTeacherRateArchived } from "@/server/teacher-actions";
import { NumberSetting } from "./settings-page";

/** The amount of a rate on a day (amounts are newest first). */
export function amountOn(rate: TeacherRate, day: string) {
  return rate.amounts.find((a) => a.validFrom <= day);
}

/** Settings → Teachers and Rates (managers). */
export function TeachersSettings() {
  const { ref, now } = useWorkspace();
  const today = cairoParts(now).date;
  const [show, setShow] = useState<"active" | "all">("active");
  const [program, setProgram] = useState("");
  const [editing, setEditing] = useState<Partial<Teacher> | null>(null);
  const [addingRate, setAddingRate] = useState<Teacher | null>(null);
  const [changing, setChanging] = useState<TeacherRate | null>(null);
  const [grouping, setGrouping] = useState<Teacher | null>(null);
  const { data: assignments } = useApi<TeacherAssignment[]>("/api/teacher-assignments");
  const runAction = useRunAction();

  const teachers = ref.teachers.filter((t) => (show === "all" || t.active) && (!program || t.programIds.includes(program)));
  const programCode = (id: string) => ref.programs.find((p) => p.id === id)?.code ?? "";

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Teachers"
          subtitle="Each teacher can have several hourly rates. A new amount starts from a date you choose, so hours before it keep the old amount."
          action={<Button size="sm" variant="primary" className="shrink-0 whitespace-nowrap" icon={<UserPlus size={14} />} onClick={() => setEditing({ active: true, programIds: [] })}>Add teacher</Button>}
        />
        <div className="grid gap-2 border-b border-line px-4 py-3 sm:grid-cols-2">
          <Select aria-label="Show teachers" className="h-9" value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
            <option value="active">Active teachers</option><option value="all">All teachers</option>
          </Select>
          <Select aria-label="Program taught" className="h-9" value={program} onChange={(e) => setProgram(e.target.value)}>
            <option value="">All programs</option>
            {ref.programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
        {teachers.length === 0 ? (
          <EmptyState icon={<GraduationCap size={22} />} title={ref.teachers.length ? "No teachers match" : "No teachers yet"}>
            {ref.teachers.length ? "Change the filters above." : "Add your teachers and their hourly rates. Support can then assign them to customers."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {teachers.map((t) => {
              const rates = ref.teacherRates.filter((r) => r.teacherId === t.id);
              const current = (assignments ?? []).filter((a) => a.teacherId === t.id && !a.endedOn);
              const students = current.filter((a) => a.enrollmentId);
              const groups = ref.groupTeachers.filter((a) => a.teacherId === t.id && !a.endedOn);
              return (
                <li key={t.id} className="px-4 py-4" data-teacher={t.fullName}>
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className={clsx("font-semibold", !t.active && "text-muted")}>{t.fullName}</span>
                        {t.programIds.map((p) => <span key={p} className="rounded-full bg-navy-50 px-2 py-0.5 text-xs font-medium text-navy-700">{programCode(p)}</span>)}
                        {!t.active && <span className="rounded-full bg-[#eeeff3] px-2 py-0.5 text-xs text-[#4b4e66]">Not active</span>}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">{[t.phone, t.email].filter(Boolean).join(" · ") || "No contact details"}</p>
                      {t.notes && <p className="mt-1 text-sm text-ink/80" dir="auto">{t.notes}</p>}
                    </div>
                    <IconButton label={`Edit ${t.fullName}`} icon={<Pencil size={14} />} onClick={() => setEditing(t)} />
                  </div>

                  <div className="mt-3 rounded-lg border border-line">
                    <div className="flex items-center justify-between border-b border-line px-3 py-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted">Hourly rates</p>
                      <Button size="sm" icon={<Plus size={14} />} onClick={() => setAddingRate(t)} disabled={!t.active}>Add rate</Button>
                    </div>
                    {rates.length === 0 ? <p className="px-3 py-3 text-sm text-muted">No rates yet. Add one before assigning this teacher.</p> : (
                      <ul className="divide-y divide-line" aria-label={`Rates of ${t.fullName}`}>
                        {rates.map((r) => {
                          const cur = amountOn(r, today);
                          const next = r.amounts.find((a) => a.validFrom > today);
                          const prev = cur ? r.amounts.find((a) => a.validFrom < cur.validFrom) : undefined;
                          return (
                            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm" data-rate={r.name}>
                              <span className={clsx("min-w-0 flex-1 font-medium", r.archived && "text-muted line-through")}>{r.name}</span>
                              <span className="font-semibold tabular-nums" data-amount>{cur ? `${formatMoney(cur.amount, r.currency)} / hour` : "Not started yet"}</span>
                              <span className="text-xs text-muted">
                                {cur && `since ${formatDay(cur.validFrom)}`}
                                {prev && ` · was ${formatMoney(prev.amount, r.currency)}`}
                                {next && ` · ${formatMoney(next.amount, r.currency)} from ${formatDay(next.validFrom)}`}
                              </span>
                              {!r.archived && <Button size="sm" onClick={() => setChanging(r)}>Change amount</Button>}
                              <IconButton label={r.archived ? `Restore ${r.name}` : `Archive ${r.name}`} icon={r.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                                onClick={() => runAction(setTeacherRateArchived(r.id, !r.archived), r.archived ? "Rate restored" : "Rate archived. Past hours keep it.", { reference: true })} />
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>

                  <div className="mt-3 flex flex-col items-start gap-x-6 gap-y-2 text-sm sm:flex-row">
                    <div className="w-full min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted"><Users size={12} aria-hidden /> Teaching now</p>
                      {students.length === 0 && groups.length === 0 ? <p className="mt-1 text-muted">No students or groups.</p> : (
                        <ul className="mt-1 space-y-0.5" aria-label={`Teaching now: ${t.fullName}`}>
                          {groups.map((g) => (
                            <li key={g.id} className="flex flex-wrap items-center gap-2">
                              <span>Group: {ref.courses.find((c) => c.id === g.courseId)?.name ?? "—"}{g.subject ? ` · ${g.subject}` : ""}</span>
                              <span className="text-xs text-muted">({ref.teacherRates.find((r) => r.id === g.rateId)?.name})</span>
                              <button className="text-xs font-medium text-muted hover:text-bad" onClick={() => runAction(endTeacherAssignment(g.id, today), "Teacher stopped for this group", { reference: true })}>Stop</button>
                            </li>
                          ))}
                          {students.map((s) => (
                            <li key={s.id}>{s.customerName}{s.subject ? ` · ${s.subject}` : ""} <span className="text-xs text-muted">({ref.teacherRates.find((r) => r.id === s.rateId)?.name})</span></li>
                          ))}
                        </ul>
                      )}
                    </div>
                    {t.active && rates.some((r) => !r.archived) && <Button size="sm" icon={<Users size={14} />} onClick={() => setGrouping(t)}>Assign to a group course</Button>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <SessionRules />

      {editing && <TeacherDialog teacher={editing} onClose={() => setEditing(null)} />}
      {addingRate && <RateDialog teacher={addingRate} onClose={() => setAddingRate(null)} />}
      {changing && <AmountDialog rate={changing} onClose={() => setChanging(null)} />}
      {grouping && <GroupDialog teacher={grouping} onClose={() => setGrouping(null)} />}
    </div>
  );
}

function TeacherDialog({ teacher, onClose }: { teacher: Partial<Teacher>; onClose: () => void }) {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const [f, setF] = useState({ fullName: teacher.fullName ?? "", phone: teacher.phone ?? "", email: teacher.email ?? "", programIds: teacher.programIds ?? [], active: teacher.active ?? true, notes: teacher.notes ?? "" });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await runAction(saveTeacher({ id: teacher.id, ...f, phone: f.phone || undefined, email: f.email || undefined, notes: f.notes || undefined }), teacher.id ? "Teacher updated" : "Teacher added", { reference: true });
    setBusy(false);
    if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title={teacher.id ? `Edit ${teacher.fullName}` : "Add teacher"} description="Teachers do not sign in to the CRM. Their details are for managers and support."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !f.fullName.trim()} onClick={save}>{busy ? "Saving…" : "Save"}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Full name" required className="sm:col-span-2">{(p) => <Input value={f.fullName} maxLength={120} onChange={(e) => setF({ ...f, fullName: e.target.value })} {...p} />}</Field>
        <Field label="Phone">{(p) => <Input dir="ltr" value={f.phone} maxLength={40} onChange={(e) => setF({ ...f, phone: e.target.value })} {...p} />}</Field>
        <Field label="Email">{(p) => <Input dir="ltr" type="email" value={f.email} maxLength={200} onChange={(e) => setF({ ...f, email: e.target.value })} {...p} />}</Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-1.5 text-[13px] font-medium">Programs taught</legend>
          <div className="flex flex-wrap gap-4">
            {ref.programs.map((p) => (
              <Checkbox key={p.id} label={p.name} checked={f.programIds.includes(p.id)}
                onChange={(v) => setF({ ...f, programIds: v ? [...f.programIds, p.id] : f.programIds.filter((x) => x !== p.id) })} />
            ))}
          </div>
        </fieldset>
        <Field label="Notes (optional)" className="sm:col-span-2">{(p) => <Textarea value={f.notes} maxLength={1000} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="e.g. Math and Reading, evenings only" {...p} />}</Field>
        {teacher.id && <div className="sm:col-span-2"><Checkbox label="Active (can be assigned to customers)" checked={f.active} onChange={(v) => setF({ ...f, active: v })} /></div>}
      </div>
    </Dialog>
  );
}

function RateDialog({ teacher, onClose }: { teacher: Teacher; onClose: () => void }) {
  const { now } = useWorkspace();
  const runAction = useRunAction();
  const today = cairoParts(now).date;
  const [f, setF] = useState({ name: "", currency: "EGP", amount: "", validFrom: academyMonth(today).from });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await runAction(addTeacherRate({ teacherId: teacher.id, name: f.name, currency: f.currency, amount: Number(f.amount), validFrom: f.validFrom }), "Rate added", { reference: true });
    setBusy(false);
    if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title={`Add a rate for ${teacher.fullName}`} description="For example SAT private, SAT group, IELTS private. Choose the rate when assigning the teacher."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !f.name.trim() || !(Number(f.amount) > 0) || !f.validFrom} onClick={save}>{busy ? "Saving…" : "Add rate"}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Rate name" required className="sm:col-span-2">{(p) => <Input value={f.name} maxLength={60} placeholder="e.g. SAT private" onChange={(e) => setF({ ...f, name: e.target.value })} {...p} />}</Field>
        <Field label={`Amount per hour (${f.currency})`} required>{(p) => <Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} {...p} />}</Field>
        <Field label="Currency">{(p) => <Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} {...p}><option value="EGP">EGP</option><option value="USD">USD</option></Select>}</Field>
        <Field label="Counts from" required hint="Hours from this date use this amount. Starts with the current Academy month (26th)." className="sm:col-span-2">
          {(p) => <Input type="date" value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} {...p} />}
        </Field>
      </div>
    </Dialog>
  );
}

function AmountDialog({ rate, onClose }: { rate: TeacherRate; onClose: () => void }) {
  const { ref, now } = useWorkspace();
  const runAction = useRunAction();
  const today = cairoParts(now).date;
  const nextMonth = shiftDay(academyMonth(today).to, 1); // the next 26th
  const current = amountOn(rate, today);
  const [f, setF] = useState({ amount: current ? String(current.amount) : "", validFrom: nextMonth });
  const [busy, setBusy] = useState(false);
  const teacher = ref.teachers.find((t) => t.id === rate.teacherId);
  const save = async () => {
    setBusy(true);
    const r = await runAction(setTeacherRateAmount(rate.id, Number(f.amount), f.validFrom), "New amount saved", { reference: true });
    setBusy(false);
    if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title={`Change ${rate.name}`} description={`${teacher?.fullName ?? ""} · now ${current ? formatMoney(current.amount, rate.currency) : "not started"} per hour. Hours before the new date keep the old amount.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !(Number(f.amount) > 0) || !f.validFrom} onClick={save}>{busy ? "Saving…" : "Save new amount"}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label={`New amount per hour (${rate.currency})`} required>{(p) => <Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} {...p} />}</Field>
        <Field label="Starts from" required hint="Usually the 26th, the first day of an Academy month.">{(p) => <Input type="date" value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} {...p} />}</Field>
      </div>
      {rate.amounts.length > 0 && (
        <div className="mt-4 text-xs text-muted">
          <p className="mb-1 font-medium text-ink">History</p>
          <ul className="space-y-0.5">{rate.amounts.map((a) => <li key={a.validFrom}>{formatMoney(a.amount, rate.currency)} from {formatDay(a.validFrom)}</li>)}</ul>
        </div>
      )}
    </Dialog>
  );
}

function GroupDialog({ teacher, onClose }: { teacher: Teacher; onClose: () => void }) {
  const { ref, now } = useWorkspace();
  const runAction = useRunAction();
  const today = cairoParts(now).date;
  const rates = ref.teacherRates.filter((r) => r.teacherId === teacher.id && !r.archived);
  const courses = ref.courses.filter((c) => c.active && (teacher.programIds.length === 0 || teacher.programIds.includes(c.programId)));
  const [f, setF] = useState({ courseId: courses[0]?.id ?? "", rateId: rates[0]?.id ?? "", subject: "", startedOn: today });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await runAction(assignTeacher({ teacherId: teacher.id, rateId: f.rateId, courseId: f.courseId, subject: f.subject || undefined, startedOn: f.startedOn }), "Teacher assigned to the group", { reference: true });
    setBusy(false);
    if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title={`Assign ${teacher.fullName} to a group course`} description="The teacher is paid per session hour of the group, however many students attend."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !f.courseId || !f.rateId} onClick={save}>{busy ? "Saving…" : "Assign"}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Course" required className="sm:col-span-2">{(p) => <Select value={f.courseId} onChange={(e) => setF({ ...f, courseId: e.target.value })} {...p}>{courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
        <Field label="Rate" required>{(p) => <Select value={f.rateId} onChange={(e) => setF({ ...f, rateId: e.target.value })} {...p}>{rates.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}</Field>
        <Field label="Starts on" required>{(p) => <Input type="date" value={f.startedOn} onChange={(e) => setF({ ...f, startedOn: e.target.value })} {...p} />}</Field>
        <Field label="Subject (optional)" className="sm:col-span-2">{(p) => <Input value={f.subject} maxLength={60} placeholder="e.g. Math" onChange={(e) => setF({ ...f, subject: e.target.value })} {...p} />}</Field>
      </div>
    </Dialog>
  );
}

/** What a cancelled or missed session counts for. Applied when a session is recorded; past sessions keep their hours. */
function SessionRules() {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const s = ref.settings;
  const save = (patch: Partial<Settings>) => runAction(updateSettings(patch), "Setting saved", { reference: true });
  return (
    <Card>
      <CardHeader title="Session rules" subtitle="Used when support records a session. Sessions already recorded keep their hours if you change these." />
      <div className="divide-y divide-line">
        <NumberSetting label="A student cancellation is late when it is less than" hint="Support ticks Late when recording a cancellation this close to the session." value={s.lateCancelHours} unit="hours before" onSave={(n) => save({ lateCancelHours: n })} />
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="text-sm"><p>Late student cancellations are paid</p><p className="text-xs text-muted">The teacher is paid the planned hours, and they come out of the student&apos;s package.</p></div>
          <Toggle label="Late student cancellations are paid" checked={s.lateCancelPaid} onChange={(v) => save({ lateCancelPaid: v })} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="text-sm"><p>No-shows are paid</p><p className="text-xs text-muted">When the student does not attend: the teacher is paid the planned hours, and they come out of the package.</p></div>
          <Toggle label="No-shows are paid" checked={s.noShowPaid} onChange={(v) => save({ noShowPaid: v })} />
        </div>
        <p className="px-4 py-3 text-xs text-muted">Cancellations in good time and cancellations by the teacher are never paid and never use package hours.</p>
      </div>
    </Card>
  );
}
