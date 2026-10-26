"use client";

import { CalendarPlus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { LeadDetail, SessionAssignment } from "@/domain/dto";
import type { TeachingSession } from "@/domain/types";
import { courseOf } from "@/lib/courses";
import { useWorkspace } from "@/lib/workspace";
import { hoursText, RecordDialog, ScheduleDialog, SessionLine } from "@/features/sessions/session-ui";

/** A private customer's sessions in the Support tab, with package hours used and left. */
export function SessionsSection({ detail, canWork }: { detail: LeadDetail; canWork: boolean }) {
  const { ref, now } = useWorkspace();
  const [recording, setRecording] = useState<TeachingSession | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const course = courseOf(ref, detail.enrollment!.courseId);
  const bought = course?.sessionsCount && course?.sessionHours ? course.sessionsCount * course.sessionHours : null;
  // Hours used before the customer was added to the CRM count too (Part D).
  const used = (detail.enrollment?.packageHoursBefore ?? 0) + detail.sessions.reduce((t, s) => t + s.studentHours, 0);
  const left = bought !== null ? bought - used : null;
  const assignments: SessionAssignment[] = detail.teachers.filter((a) => !a.endedOn).map((a) => ({
    id: a.id, teacherId: a.teacherId, rateId: a.rateId, enrollmentId: a.enrollmentId, subject: a.subject,
    label: `${ref.teachers.find((t) => t.id === a.teacherId)?.fullName ?? "—"}${a.subject ? ` (${a.subject})` : ""}`,
  }));
  const past = detail.sessions.filter((s) => new Date(s.startsAt) <= now);
  const upcoming = detail.sessions.filter((s) => new Date(s.startsAt) > now);
  const shown = [...past.slice(showAll ? 0 : -5), ...upcoming.slice(0, showAll ? undefined : 3)];
  const hidden = detail.sessions.length - shown.length;
  // Weekly series as one line each: "Weekly · Tuesdays 5:00 PM · 4 of 6 left".
  const series = [...new Set(detail.sessions.map((x) => x.seriesId).filter(Boolean))].map((id) => {
    const list = detail.sessions.filter((x) => x.seriesId === id);
    const first = new Date(list[0].startsAt);
    const day = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "Africa/Cairo" }).format(first);
    const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "Africa/Cairo" }).format(first);
    return { id: id as string, label: `Weekly · ${day}s ${time}`, left: list.filter((x) => x.status === "scheduled").length, total: list.length };
  });

  if (detail.teachers.length === 0 && detail.sessions.length === 0) return null;
  return (
    <section aria-label="Sessions">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Sessions</h3>
        {canWork && assignments.length > 0 && <Button size="sm" icon={<CalendarPlus size={14} />} onClick={() => setScheduling(true)}>Schedule</Button>}
      </div>
      {bought !== null && (
        <div className="mb-2 rounded-lg border border-line px-3 py-2 text-sm" data-testid="package">
          <div className="flex flex-wrap justify-between gap-2">
            <span>Package: <b className="font-semibold">{hoursText(used)}</b> used of {hoursText(bought)}</span>
            <span className={left !== null && left <= 2 ? "font-semibold text-bad" : "text-muted"}>{hoursText(Math.max(left ?? 0, 0))} left</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-navy-50" role="progressbar" aria-label="Package hours used" aria-valuemin={0} aria-valuemax={bought} aria-valuenow={used}>
            <div className={left !== null && left <= 2 ? "h-full bg-bad" : "h-full bg-navy-700"} style={{ width: `${Math.min(100, (used / bought) * 100)}%` }} />
          </div>
        </div>
      )}
      {series.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Weekly series">
          {series.map((x) => (
            <li key={x.id} className="rounded-full border border-line bg-white px-2.5 py-0.5 text-xs" data-series={x.label}>{x.label} · {x.left} of {x.total} left</li>
          ))}
        </ul>
      )}
      {detail.sessions.length === 0 ? (
        <p className="text-sm text-muted">{canWork ? "No sessions yet. Schedule the first one." : "No sessions yet."}</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {shown.map((s) => <SessionLine key={s.id} s={s} showCustomer={false} canRun={canWork} onRecord={setRecording} />)}
        </ul>
      )}
      {hidden > 0 && <button className="mt-1.5 text-xs font-medium text-navy-700 hover:underline" onClick={() => setShowAll(true)}>Show all {detail.sessions.length} sessions</button>}
      {recording && <RecordDialog session={recording} onClose={() => setRecording(null)} />}
      {scheduling && <ScheduleDialog assignments={assignments} fixed={assignments[0]?.id} onClose={() => setScheduling(false)} />}
    </section>
  );
}
