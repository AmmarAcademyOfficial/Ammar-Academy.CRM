"use client";

import { AlertTriangle, CalendarPlus, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Button, IconButton } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { Select } from "@/components/ui/form";
import { Card, CardHeader, PageHeader, SkeletonRows } from "@/components/ui/misc";
import { shiftDay } from "@/domain/accounting";
import type { SessionsData } from "@/domain/dto";
import { cairoParts } from "@/domain/rules";
import type { TeachingSession } from "@/domain/types";
import { formatDay } from "@/features/leads/filters";
import { useApi, useWorkspace } from "@/lib/workspace";
import { EmptySessions, hoursText, RecordDialog, ScheduleDialog, SessionLine } from "./session-ui";

type View = "day" | "week";

/** Sessions (support and managers): today's and this week's sessions, recording, and what still needs recording. */
export function SessionsPage() {
  const { ref, me, now } = useWorkspace();
  const today = cairoParts(now).date;
  const [view, setView] = useState<View>("day");
  const [day, setDay] = useState(today);
  const [teacher, setTeacher] = useState("");
  const [recording, setRecording] = useState<TeachingSession | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const weekStart = shiftDay(day, -new Date(`${day}T12:00:00Z`).getUTCDay());
  const range = view === "day" ? { from: day, to: day } : { from: weekStart, to: shiftDay(weekStart, 6) };
  const { data, loading } = useApi<SessionsData>(`/api/sessions?from=${range.from}&to=${range.to}`);

  const match = (s: TeachingSession) => !teacher || s.teacherId === teacher;
  const sessions = (data?.sessions ?? []).filter(match);
  // Earlier unrecorded sessions not already shown in the list below.
  const unrecorded = (data?.unrecorded ?? []).filter(match).filter((s) => {
    const d = cairoParts(new Date(s.startsAt)).date;
    return d < range.from || d > range.to;
  });
  const byDay = new Map<string, TeachingSession[]>();
  for (const s of sessions) {
    const d = cairoParts(new Date(s.startsAt)).date;
    byDay.set(d, [...(byDay.get(d) ?? []), s]);
  }
  const taught = sessions.filter((s) => s.status === "done").reduce((t, s) => t + (s.hours ?? 0), 0);
  const paid = sessions.reduce((t, s) => t + s.paidHours, 0);
  const step = view === "day" ? 1 : 7;
  const teachersInUse = ref.teachers.filter((t) => t.active || sessions.some((s) => s.teacherId === t.id));

  return (
    <div>
      <PageHeader
        title="Sessions"
        subtitle={me.role === "support" ? "Your customers' sessions and group classes. Record each one after it takes place." : "Every teaching session. Support records each one after it takes place."}
        actions={<Button variant="primary" icon={<CalendarPlus size={16} />} onClick={() => setScheduling(true)} disabled={!data}>Schedule session</Button>}
      />

      <Card className="mb-4 flex flex-wrap items-center gap-2 p-3">
        <div role="tablist" aria-label="Session view" className="flex gap-1">
          {(["day", "week"] as View[]).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}
              className={clsx("h-9 rounded-full px-4 text-sm font-medium", view === v ? "bg-navy-900 text-white" : "border border-line bg-white hover:bg-navy-50")}>
              {v === "day" ? "Day" : "Week"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <IconButton label={view === "day" ? "Previous day" : "Previous week"} icon={<ChevronLeft size={16} />} onClick={() => setDay(shiftDay(day, -step))} />
          <span className="min-w-[11rem] text-center text-sm font-medium" data-testid="session-range">
            {view === "day" ? `${day === today ? "Today · " : ""}${formatDay(day)}` : `${formatDay(range.from)} – ${formatDay(range.to)}`}
          </span>
          <IconButton label={view === "day" ? "Next day" : "Next week"} icon={<ChevronRight size={16} />} onClick={() => setDay(shiftDay(day, step))} />
          {day !== today && <Button size="sm" onClick={() => setDay(today)}>Today</Button>}
        </div>
        <Select aria-label="Teacher" className="h-9 sm:ml-auto sm:w-56" value={teacher} onChange={(e) => setTeacher(e.target.value)}>
          <option value="">All teachers</option>
          {teachersInUse.map((t) => <option key={t.id} value={t.id}>{t.fullName}</option>)}
        </Select>
      </Card>

      {unrecorded.length > 0 && (
        <Card className="mb-4 border-orange-500/40">
          <CardHeader title={<span className="flex items-center gap-2"><AlertTriangle size={16} className="text-warn" aria-hidden /> Needs recording</span>} count={unrecorded.length}
            subtitle="Earlier sessions still marked as scheduled. Record what happened so teachers are paid correctly." />
          <ul className="divide-y divide-line" aria-label="Needs recording">
            {unrecorded.map((s) => <SessionLine key={s.id} s={s} canRun onRecord={setRecording} />)}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader title={view === "day" ? "Sessions" : "This week"} count={sessions.length}
          subtitle={sessions.length ? `${hoursText(taught)} taught · ${hoursText(paid)} counted for teachers' pay` : undefined} />
        {!data && loading ? <SkeletonRows rows={4} /> : sessions.length === 0 ? (
          <EmptySessions>No sessions {view === "day" ? "on this day" : "this week"}.</EmptySessions>
        ) : view === "day" ? (
          <ul className="divide-y divide-line" aria-label="Sessions">{sessions.map((s) => <SessionLine key={s.id} s={s} canRun onRecord={setRecording} />)}</ul>
        ) : (
          <div aria-label="Sessions">
            {[...byDay.entries()].map(([d, list]) => (
              <section key={d} aria-label={formatDay(d)}>
                <h3 className="border-b border-line bg-canvas px-4 py-1.5 text-xs font-semibold text-muted">{formatDay(d)}{d === today ? " · Today" : ""}</h3>
                <ul className="divide-y divide-line">{list.map((s) => <SessionLine key={s.id} s={s} canRun onRecord={setRecording} />)}</ul>
              </section>
            ))}
          </div>
        )}
      </Card>

      {recording && <RecordDialog session={recording} onClose={() => setRecording(null)} />}
      {scheduling && data && <ScheduleDialog assignments={data.assignments} onClose={() => setScheduling(false)} />}
    </div>
  );
}
