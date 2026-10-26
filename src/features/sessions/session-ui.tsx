"use client";

import { CalendarClock, CheckCircle2, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Pill } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { Dialog } from "@/components/ui/overlay";
import type { SessionAssignment } from "@/domain/dto";
import { cairoParts, formatCairo } from "@/domain/rules";
import type { SessionStatus, TeachingSession } from "@/domain/types";
import { useToast } from "@/components/ui/toast";
import { useRunAction } from "@/lib/run-action";
import { useWorkspace } from "@/lib/workspace";
import { changeSessionSeries, deleteSession, recordSession, scheduleSessions, sessionSeriesInfo, type SeriesInfo } from "@/server/session-actions";
import { cairoLocalInput, fromCairoLocal } from "@/features/lead-panel/dialogs";

export const SESSION_STATUS: Record<SessionStatus, [string, string]> = {
  scheduled: ["bg-[#eeeff3] text-[#4b4e66]", "Scheduled"],
  done: ["bg-ok-bg text-ok", "Done"],
  cancelled_student: ["bg-warn-bg text-warn", "Cancelled by student"],
  cancelled_teacher: ["bg-[#eeeff3] text-[#4b4e66]", "Cancelled by teacher"],
  no_show: ["bg-bad-bg text-bad", "No-show"],
};

export function SessionBadge({ s }: { s: TeachingSession }) {
  const [cls, label] = SESSION_STATUS[s.status];
  return <Pill className={cls}>{s.status === "cancelled_student" && s.lateCancel ? "Cancelled late by student" : label}</Pill>;
}

export const hoursText = (h: number) => `${Number(h.toFixed(2))} h`;

/** One session in a list: time, who, what happened, and the Record button. */
export function SessionLine({ s, showCustomer = true, canRun, onRecord, extra }: { s: TeachingSession; showCustomer?: boolean; canRun: boolean; onRecord: (s: TeachingSession) => void; extra?: ReactNode }) {
  const { ref, now, openInquiry } = useWorkspace();
  const teacher = ref.teachers.find((t) => t.id === s.teacherId)?.fullName ?? "—";
  const who = s.courseId ? `Group: ${ref.courses.find((c) => c.id === s.courseId)?.name ?? "—"}` : s.customerName ?? "";
  const due = s.status === "scheduled" && new Date(s.startsAt) < now;
  return (
    <li className={clsx("flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm", due && "bg-warn-bg/40")} data-session={s.status}>
      <span className="w-full shrink-0 tabular-nums text-muted sm:w-36">{formatCairo(s.startsAt, "datetime")}</span>
      <span className="min-w-0 flex-1">
        {showCustomer && (s.inquiryId ? <button className="font-medium hover:underline" onClick={() => openInquiry(s.inquiryId!)}>{who}</button> : <span className="font-medium">{who}</span>)}
        {showCustomer && " · "}
        <span>{teacher}</span>{s.subject && <span className="text-muted"> ({s.subject})</span>}
        <span className="block text-xs text-muted">
          {s.status === "done" ? `${hoursText(s.hours ?? 0)} taught` : `${hoursText(s.plannedHours)} planned`}
          {s.status !== "scheduled" && s.status !== "done" && ` · ${hoursText(s.paidHours)} paid`}
          {s.note && ` · ${s.note}`}
        </span>
      </span>
      <SessionBadge s={s} />
      {due && <span className="text-xs font-medium text-warn">Needs recording</span>}
      {canRun && <Button size="sm" variant={due ? "primary" : "secondary"} icon={<CheckCircle2 size={14} />} onClick={() => onRecord(s)}>{s.status === "scheduled" ? "Record" : "Change"}</Button>}
      {extra}
    </li>
  );
}

/** Record what happened in a session (or move it while it is still scheduled). */
export function RecordDialog({ session, onClose }: { session: TeachingSession; onClose: () => void }) {
  const { ref, me, now } = useWorkspace();
  const runAction = useRunAction();
  const toast = useToast();
  const st = ref.settings;
  const future = new Date(session.startsAt) > new Date(now.getTime() + 3600_000);
  const [status, setStatus] = useState<SessionStatus>(session.status === "scheduled" ? (future ? "scheduled" : "done") : session.status);
  const [hours, setHours] = useState(String(session.hours ?? session.plannedHours));
  const [late, setLate] = useState(session.lateCancel);
  const [note, setNote] = useState(session.note ?? "");
  const [when, setWhen] = useState(cairoLocalInput(new Date(session.startsAt)));
  const [planned, setPlanned] = useState(String(session.plannedHours));
  const [busy, setBusy] = useState(false);
  // A session of a weekly series: a move or a removal can also apply to the following ones or the whole series.
  const [series, setSeries] = useState<SeriesInfo | null>(null);
  const [scope, setScope] = useState<"one" | "following" | "all">("one");
  useEffect(() => {
    if (!session.seriesId || session.status !== "scheduled") return;
    let live = true;
    void sessionSeriesInfo(session.id).then((r) => { if (live && r.ok && r.value.seriesId) setSeries(r.value); });
    return () => { live = false; };
  }, [session.id, session.seriesId, session.status]);
  const inSeries = !!series && status === "scheduled";
  const reach = scope === "following" ? series?.following ?? 1 : scope === "all" ? series?.all ?? 1 : 1;
  const teacher = ref.teachers.find((t) => t.id === session.teacherId)?.fullName ?? "";
  const paidPreview =
    status === "done" ? Number(hours) || 0
    : status === "cancelled_student" ? (late && st.lateCancelPaid ? session.plannedHours : 0)
    : status === "no_show" ? (st.noShowPaid ? session.plannedHours : 0) : 0;

  const save = async () => {
    setBusy(true);
    const moved = status === "scheduled" && (when !== cairoLocalInput(new Date(session.startsAt)) || Number(planned) !== session.plannedHours);
    if (inSeries && scope !== "one" && moved) {
      const r = await runAction(changeSessionSeries({ id: session.id, scope, action: "move", startsAt: fromCairoLocal(when), plannedHours: Number(planned) }), null);
      setBusy(false);
      if (r.ok) { toast.success(`${r.value} session${r.value === 1 ? "" : "s"} moved`); onClose(); }
      return;
    }
    const r = await runAction(recordSession({
      id: session.id, status, hours: status === "done" ? Number(hours) : undefined, late: status === "cancelled_student" ? late : undefined, note: note || undefined,
      startsAt: moved ? fromCairoLocal(when) : undefined, plannedHours: moved ? Number(planned) : undefined,
    }), status === "scheduled" ? "Session updated" : "Session recorded");
    setBusy(false);
    if (r.ok) onClose();
  };
  const remove = async () => {
    setBusy(true);
    if (inSeries && scope !== "one") {
      const s2 = await runAction(changeSessionSeries({ id: session.id, scope, action: "remove" }), null);
      setBusy(false);
      if (s2.ok) { toast.success(`${s2.value} session${s2.value === 1 ? "" : "s"} removed`); onClose(); }
      return;
    }
    const r = await runAction(deleteSession(session.id), "Session removed");
    setBusy(false);
    if (r.ok) onClose();
  };
  const canRemove = session.status === "scheduled" || me.role === "manager";

  return (
    <Dialog open onClose={onClose} title="Record session" description={`${teacher} · ${formatCairo(session.startsAt)} · ${hoursText(session.plannedHours)} planned`}
      footer={<>
        {canRemove && <Button variant="danger" icon={<Trash2 size={14} />} className="mr-auto" disabled={busy} onClick={remove}>{inSeries && scope !== "one" ? `Remove ${reach}` : "Remove"}</Button>}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || (status === "done" && !(Number(hours) > 0))} onClick={save}>{busy ? "Saving…" : "Save"}</Button>
      </>}>
      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="What happened?" required className="sm:col-span-2">
          {(p) => (
            <Select value={status} onChange={(e) => setStatus(e.target.value as SessionStatus)} {...p}>
              <option value="scheduled">Not yet (still scheduled)</option>
              {!future && <option value="done">Done</option>}
              {!future && <option value="cancelled_student">Cancelled by the student</option>}
              {!future && <option value="cancelled_teacher">Cancelled by the teacher</option>}
              {!future && <option value="no_show">The student did not attend</option>}
            </Select>
          )}
        </Field>
        {status === "done" && (
          <Field label="Hours taught" required hint="Change it if the session was shorter or longer.">
            {(p) => <Input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} {...p} />}
          </Field>
        )}
        {status === "cancelled_student" && (
          <div className="sm:col-span-2">
            <Checkbox label={`Cancelled less than ${st.lateCancelHours} hours before the session`} checked={late} onChange={setLate}
              description={st.lateCancelPaid ? "A late cancellation is paid to the teacher and uses the student's hours." : "Late cancellations are not paid (Settings)."} />
          </div>
        )}
        {inSeries && series && (
          <fieldset className="sm:col-span-2" data-testid="series-scope">
            <legend className="mb-1.5 text-sm font-medium">Apply a move or removal to</legend>
            <div className="grid gap-1.5 sm:grid-cols-3" role="radiogroup">
              {([["one", "Only this session"], ["following", `This and the following (${series.following})`], ["all", `All not yet recorded (${series.all})`]] as const).map(([v, label]) => (
                <label key={v} className={clsx("flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm", scope === v ? "border-navy-900 bg-navy-50 font-medium" : "border-line hover:bg-navy-50/60")}>
                  <input type="radio" name="series-scope" checked={scope === v} onChange={() => setScope(v)} className="accent-navy-900" />{label}
                </label>
              ))}
            </div>
            {scope !== "one" && <p className="mt-1.5 text-xs text-muted">{scope === "following" ? "Each following session moves by the same amount as this one." : "Every session of the series moves by the same amount as this one."} Recorded sessions{series.recorded ? ` (${series.recorded})` : ""} and closed salary months are not changed.</p>}
          </fieldset>
        )}
        {status === "scheduled" && (
          <>
            <Field label="Date and time" required>{(p) => <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} {...p} />}</Field>
            <Field label="Planned hours" required>{(p) => <Input inputMode="decimal" value={planned} onChange={(e) => setPlanned(e.target.value)} {...p} />}</Field>
          </>
        )}
        <Field label="Note (optional)" className="sm:col-span-2">{(p) => <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Covered algebra, homework set" {...p} />}</Field>
      </div>
      {status !== "scheduled" && (
        <p className="mt-3 rounded-lg bg-canvas px-3 py-2 text-sm" data-testid="paid-preview">
          Paid to the teacher: <b className="font-semibold">{hoursText(paidPreview)}</b>
          {session.enrollmentId && <> · from the student&apos;s hours: <b className="font-semibold">{hoursText(paidPreview)}</b></>}
        </p>
      )}
    </Dialog>
  );
}

/** Schedule one session or a weekly series for a teacher assignment. */
export function ScheduleDialog({ assignments, fixed, onClose }: { assignments: SessionAssignment[]; fixed?: string; onClose: () => void }) {
  const { now } = useWorkspace();
  const runAction = useRunAction();
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const [f, setF] = useState({
    assignmentId: fixed ?? assignments[0]?.id ?? "",
    when: `${cairoParts(tomorrow).date}T17:00`,
    hours: "2",
    repeat: "0",
    note: "",
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await runAction(scheduleSessions({ assignmentId: f.assignmentId, startsAt: fromCairoLocal(f.when), plannedHours: Number(f.hours), repeatWeeks: Number(f.repeat), note: f.note || undefined }),
      Number(f.repeat) > 0 ? `${Number(f.repeat) + 1} weekly sessions scheduled` : "Session scheduled");
    setBusy(false);
    if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title="Schedule session" description="Times are Cairo time. A past date works too, to add a session that already happened, then record it."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !f.assignmentId || !f.when || !(Number(f.hours) >= 0.25)} onClick={save}>{busy ? "Saving…" : "Schedule"}</Button></>}>
      {assignments.length === 0 ? (
        <p className="text-sm text-muted">Assign a teacher first (customer → Support tab → Assign teacher).</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          {!fixed || assignments.length > 1 ? (
            <Field label="Teacher and student" required className="sm:col-span-2">
              {(p) => <Select value={f.assignmentId} onChange={(e) => setF({ ...f, assignmentId: e.target.value })} {...p}>{assignments.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</Select>}
            </Field>
          ) : null}
          <Field label="Date and time" required>{(p) => <Input type="datetime-local" value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} {...p} />}</Field>
          <Field label="Hours" required>{(p) => <Input inputMode="decimal" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} {...p} />}</Field>
          <Field label="Repeat weekly" hint="Adds the same day and time in the following weeks.">
            {(p) => (
              <Select value={f.repeat} onChange={(e) => setF({ ...f, repeat: e.target.value })} {...p}>
                <option value="0">Just once</option>
                {[1, 3, 5, 7, 11, 15].map((n) => <option key={n} value={String(n)}>{n + 1} weeks in total</option>)}
              </Select>
            )}
          </Field>
          <Field label="Note (optional)">{(p) => <Input value={f.note} maxLength={300} onChange={(e) => setF({ ...f, note: e.target.value })} {...p} />}</Field>
        </div>
      )}
    </Dialog>
  );
}

export function EmptySessions({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted"><CalendarClock size={16} aria-hidden /> {children}</p>
  );
}
