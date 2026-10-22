"use client";

import { GraduationCap, UserPlus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { Dialog } from "@/components/ui/overlay";
import type { LeadDetail } from "@/domain/dto";
import { cairoParts, formatMoney } from "@/domain/rules";
import { formatDay } from "@/features/leads/filters";
import { amountOn } from "@/features/settings/teachers-settings";
import { useRunAction } from "@/lib/run-action";
import { useWorkspace } from "@/lib/workspace";
import { assignTeacher, endTeacherAssignment } from "@/server/teacher-actions";

/**
 * A customer's teachers, in the Support tab: private teachers assigned to this customer, plus the
 * group course's teachers. Managers and the support owner assign and stop private teachers.
 */
export function TeachersSection({ detail, canWork }: { detail: LeadDetail; canWork: boolean }) {
  const { ref, now } = useWorkspace();
  const runAction = useRunAction();
  const [assigning, setAssigning] = useState(false);
  const today = cairoParts(now).date;
  const e = detail.enrollment!;
  const current = detail.teachers.filter((a) => !a.endedOn);
  const past = detail.teachers.filter((a) => a.endedOn);
  const group = ref.groupTeachers.filter((a) => a.courseId === e.courseId && !a.endedOn);
  const name = (id: string) => ref.teachers.find((t) => t.id === id)?.fullName ?? "—";
  const rate = (id: string) => ref.teacherRates.find((r) => r.id === id);

  return (
    <section aria-label="Teachers">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Teachers</h3>
        {canWork && <Button size="sm" icon={<UserPlus size={14} />} onClick={() => setAssigning(true)}>Assign teacher</Button>}
      </div>
      {current.length === 0 && group.length === 0 ? (
        <p className="text-sm text-muted">{canWork ? "No teacher yet. Assign the teacher who will teach this customer." : "No teacher assigned yet."}</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {current.map((a) => {
            const r = rate(a.rateId);
            const amt = r ? amountOn(r, today) : undefined;
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm" data-assignment={name(a.teacherId)}>
                <GraduationCap size={15} className="text-muted" aria-hidden />
                <span className="font-medium">{name(a.teacherId)}</span>
                {a.subject && <span>· {a.subject}</span>}
                <span className="text-xs text-muted">{r?.name}{amt ? ` · ${formatMoney(amt.amount, r!.currency)}/h` : ""} · since {formatDay(a.startedOn)}</span>
                {canWork && (
                  <button className="ml-auto text-xs font-medium text-muted hover:text-bad" onClick={() => runAction(endTeacherAssignment(a.id, today), "Teacher stopped. Past sessions stay on record.")}>
                    Stop
                  </button>
                )}
              </li>
            );
          })}
          {group.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
              <GraduationCap size={15} className="text-muted" aria-hidden />
              <span className="font-medium">{name(a.teacherId)}</span>
              {a.subject && <span>· {a.subject}</span>}
              <span className="text-xs text-muted">Group course teacher</span>
            </li>
          ))}
        </ul>
      )}
      {past.length > 0 && (
        <p className="mt-1.5 text-xs text-muted">Before: {past.map((a) => `${name(a.teacherId)}${a.subject ? ` (${a.subject})` : ""} until ${formatDay(a.endedOn!)}`).join(", ")}</p>
      )}
      {assigning && <AssignDialog detail={detail} onClose={() => setAssigning(false)} />}
    </section>
  );
}

function AssignDialog({ detail, onClose }: { detail: LeadDetail; onClose: () => void }) {
  const { ref, now } = useWorkspace();
  const runAction = useRunAction();
  const today = cairoParts(now).date;
  const program = detail.row.inquiry.programId;
  const teachers = ref.teachers.filter((t) => t.active && ref.teacherRates.some((r) => r.teacherId === t.id && !r.archived));
  const forProgram = teachers.filter((t) => t.programIds.includes(program));
  const list = forProgram.length ? [...forProgram, ...teachers.filter((t) => !forProgram.includes(t))] : teachers;
  const [f, setF] = useState({ teacherId: list[0]?.id ?? "", rateId: "", subject: "", startedOn: today });
  const rates = ref.teacherRates.filter((r) => r.teacherId === f.teacherId && !r.archived);
  const rateId = rates.some((r) => r.id === f.rateId) ? f.rateId : rates[0]?.id ?? "";
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await runAction(assignTeacher({ teacherId: f.teacherId, rateId, enrollmentId: detail.enrollment!.id, subject: f.subject || undefined, startedOn: f.startedOn }), "Teacher assigned");
    setBusy(false);
    if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title="Assign teacher" description="The rate decides what the teacher is paid per hour for this customer."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !f.teacherId || !rateId} onClick={save}>{busy ? "Saving…" : "Assign"}</Button></>}>
      {list.length === 0 ? (
        <p className="text-sm text-muted">No active teachers with a rate yet. A manager adds them in Settings → Teachers and Rates.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <Field label="Teacher" required className="sm:col-span-2">
            {(p) => (
              <Select value={f.teacherId} onChange={(e) => setF({ ...f, teacherId: e.target.value, rateId: "" })} {...p}>
                {list.map((t) => <option key={t.id} value={t.id}>{t.fullName}{forProgram.length && !t.programIds.includes(program) ? " (other program)" : ""}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Rate" required>
            {(p) => (
              <Select value={rateId} onChange={(e) => setF({ ...f, rateId: e.target.value })} {...p}>
                {rates.map((r) => {
                  const a = amountOn(r, today);
                  return <option key={r.id} value={r.id}>{r.name}{a ? ` · ${formatMoney(a.amount, r.currency)}/h` : ""}</option>;
                })}
              </Select>
            )}
          </Field>
          <Field label="Starts on" required>{(p) => <Input type="date" value={f.startedOn} onChange={(e) => setF({ ...f, startedOn: e.target.value })} {...p} />}</Field>
          <Field label="Subject (optional)" className="sm:col-span-2">{(p) => <Input value={f.subject} maxLength={60} placeholder="e.g. Math, Reading" onChange={(e) => setF({ ...f, subject: e.target.value })} {...p} />}</Field>
        </div>
      )}
    </Dialog>
  );
}
