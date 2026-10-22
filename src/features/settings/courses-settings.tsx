"use client";

import { Archive, ArchiveRestore, CalendarDays, Clock, GraduationCap, Pencil, Plus, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { TAG_COLORS } from "@/components/ui/badges";
import { Button, IconButton } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { Field, Input, Select, Textarea, Toggle } from "@/components/ui/form";
import { Card, CardHeader, EmptyState } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import { formatCairo } from "@/domain/rules";
import type { Course, CourseType, TagColor } from "@/domain/types";
import { DELIVERY_LABEL, courseFacts, priceText } from "@/lib/courses";
import { useRunAction } from "@/lib/run-action";
import { useWorkspace } from "@/lib/workspace";
import { saveCourse, saveCourseType, setCourseActive, setCourseTypeArchived } from "@/server/payment-actions";

export function CourseTypeChip({ type }: { type: CourseType | undefined }) {
  if (!type) return <span className="text-xs text-muted">No type</span>;
  const c = TAG_COLORS[type.color];
  return (
    <span className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs font-medium" style={{ background: c.bg, color: c.fg }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.dot }} aria-hidden />
      {type.name}
    </span>
  );
}

export function CoursesSettings() {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const [program, setProgram] = useState("all");
  const [type, setType] = useState("all");
  const [status, setStatus] = useState<"active" | "closed" | "all">("active");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Partial<Course> | null>(null);
  const [editingType, setEditingType] = useState<Partial<CourseType> | null>(null);

  const courses = useMemo(() => ref.courses.filter((c) =>
    (program === "all" || c.programId === program) &&
    (type === "all" || c.courseTypeId === type) &&
    (status === "all" || (status === "active" ? c.active : !c.active)) &&
    (!search.trim() || c.name.toLowerCase().includes(search.trim().toLowerCase())),
  ), [ref.courses, program, type, status, search]);
  const programName = (id: string) => ref.programs.find((p) => p.id === id)?.code ?? "";

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Courses"
          subtitle="What the Academy sells. Agents link leads to a course; payments start from its price."
          action={<Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setEditing({ programId: ref.programs[0]?.id, currency: "EGP", delivery: "online", active: true })}>Add course</Button>}
        />
        <div className="grid gap-2 border-b border-line px-4 py-3 sm:grid-cols-4">
          <Input aria-label="Search courses" placeholder="Search courses" value={search} onChange={(e) => setSearch(e.target.value)} className="h-9" />
          <Select aria-label="Program" value={program} onChange={(e) => setProgram(e.target.value)} className="h-9">
            <option value="all">All programs</option>
            {ref.programs.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
          </Select>
          <Select aria-label="Course type" value={type} onChange={(e) => setType(e.target.value)} className="h-9">
            <option value="all">All course types</option>
            {ref.courseTypes.filter((t) => !t.archived).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="h-9">
            <option value="active">Open for new leads</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </Select>
        </div>
        {courses.length === 0 ? (
          <EmptyState icon={<GraduationCap size={22} />} title={ref.courses.length ? "No courses match these filters" : "No courses yet"}>
            {ref.courses.length ? "Change the filters above." : "Add the courses you sell, with their prices and details."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {courses.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className={clsx("font-medium", !c.active && "text-muted")}>{c.name}</span>
                    <span className="text-xs text-muted">{programName(c.programId)}</span>
                    <CourseTypeChip type={ref.courseTypes.find((t) => t.id === c.courseTypeId)} />
                    {!c.active && <span className="rounded-full bg-[#eeeff3] px-2 py-0.5 text-xs text-[#4b4e66]">Closed</span>}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{courseFacts(c)}</p>
                  <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
                    {c.startDate && <span className="inline-flex items-center gap-1"><CalendarDays size={12} aria-hidden />{formatCairo(c.startDate, "date")}{c.endDate ? ` – ${formatCairo(c.endDate, "date")}` : ""}</span>}
                    {c.schedule && <span className="inline-flex items-center gap-1"><Clock size={12} aria-hidden />{c.schedule}</span>}
                    {c.capacity && <span className="inline-flex items-center gap-1"><Users size={12} aria-hidden />Up to {c.capacity}</span>}
                  </p>
                  {c.description && <p className="mt-1 line-clamp-2 text-sm text-ink/80" dir="auto">{c.description}</p>}
                  {ref.groupTeachers.some((a) => a.courseId === c.id && !a.endedOn) && (
                    <p className="mt-0.5 text-xs text-muted" data-course-teachers>
                      Teacher: {ref.groupTeachers.filter((a) => a.courseId === c.id && !a.endedOn).map((a) => `${ref.teachers.find((t) => t.id === a.teacherId)?.fullName ?? "—"}${a.subject ? ` (${a.subject})` : ""}`).join(", ")}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-semibold tabular-nums">{priceText(c)}</span>
                  <IconButton label={`Edit ${c.name}`} icon={<Pencil size={14} />} onClick={() => setEditing(c)} />
                  <Toggle label={c.active ? `Close ${c.name} for new leads` : `Reopen ${c.name}`} checked={c.active} onChange={(v) => runAction(setCourseActive(c.id, v), v ? "Course reopened" : "Course closed for new leads", { reference: true })} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Course types"
          subtitle="Group, Private 1:1, Intensive… Used to organise the catalog and to filter leads."
          action={<Button size="sm" icon={<Plus size={14} />} onClick={() => setEditingType({ color: "blue" })}>Add type</Button>}
        />
        <ul className="divide-y divide-line">
          {ref.courseTypes.map((t) => {
            const count = ref.courses.filter((c) => c.courseTypeId === t.id).length;
            return (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <CourseTypeChip type={t} />
                <span className="min-w-0 flex-1 truncate text-muted">{t.description}</span>
                <span className="text-xs text-muted">{count} course{count === 1 ? "" : "s"}</span>
                {t.archived && <span className="text-xs text-muted">Archived</span>}
                <IconButton label={`Edit ${t.name}`} icon={<Pencil size={14} />} onClick={() => setEditingType(t)} />
                <IconButton label={t.archived ? `Restore ${t.name}` : `Archive ${t.name}`} icon={t.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                  onClick={() => runAction(setCourseTypeArchived(t.id, !t.archived), t.archived ? "Course type restored" : "Course type archived. Existing courses keep it.", { reference: true })} />
              </li>
            );
          })}
        </ul>
      </Card>

      {editing && <CourseDialog course={editing} onClose={() => setEditing(null)} />}
      {editingType && <CourseTypeDialog type={editingType} onClose={() => setEditingType(null)} />}
    </div>
  );
}

function CourseDialog({ course, onClose }: { course: Partial<Course>; onClose: () => void }) {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const types = ref.courseTypes.filter((t) => !t.archived || t.id === course.courseTypeId);
  const [f, setF] = useState({
    programId: course.programId ?? ref.programs[0]?.id ?? "",
    courseTypeId: course.courseTypeId ?? types[0]?.id ?? "",
    name: course.name ?? "",
    price: course.price === null || course.price === undefined ? "" : String(course.price),
    currency: course.currency ?? "EGP",
    delivery: course.delivery ?? "online",
    durationWeeks: course.durationWeeks ? String(course.durationWeeks) : "",
    sessionsCount: course.sessionsCount ? String(course.sessionsCount) : "",
    sessionHours: course.sessionHours ? String(course.sessionHours) : "",
    schedule: course.schedule ?? "",
    startDate: course.startDate ?? "",
    endDate: course.endDate ?? "",
    capacity: course.capacity ? String(course.capacity) : "",
    description: course.description ?? "",
    active: course.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const n = (v: string) => (v.trim() === "" ? null : Number(v));
  const save = async () => {
    setBusy(true);
    const r = await runAction(saveCourse({
      id: course.id, programId: f.programId, courseTypeId: f.courseTypeId, name: f.name, price: n(f.price), currency: f.currency,
      delivery: f.delivery, durationWeeks: n(f.durationWeeks), sessionsCount: n(f.sessionsCount), sessionHours: n(f.sessionHours),
      schedule: f.schedule || undefined, startDate: f.startDate, endDate: f.endDate, capacity: n(f.capacity), description: f.description || undefined, active: f.active,
    }), course.id ? "Course saved" : "Course added", { reference: true });
    setBusy(false);
    if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} className="max-w-2xl" title={course.id ? "Edit course" : "Add course"}
      description={course.id ? "Changing the price applies to new enrollments only; agreed totals already made stay as they are." : "Agents can link leads to this course and start an enrollment from its price."}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save course"}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Course name" required className="sm:col-span-2">{(p) => <Input value={f.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. SAT · December Intensive" {...p} />}</Field>
        <Field label="Program" required>{(p) => <Select value={f.programId} onChange={(e) => set({ programId: e.target.value })} {...p}>{ref.programs.map((pr) => <option key={pr.id} value={pr.id}>{pr.code} · {pr.name}</option>)}</Select>}</Field>
        <Field label="Course type" required>{(p) => <Select value={f.courseTypeId} onChange={(e) => set({ courseTypeId: e.target.value })} {...p}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}</Field>
        <div className="grid grid-cols-[1fr_110px] gap-3">
          <Field label="Price" hint="Leave empty for “price on request”.">{(p) => <Input inputMode="decimal" value={f.price} onChange={(e) => set({ price: e.target.value })} placeholder="12000" {...p} />}</Field>
          <Field label="Currency">{(p) => <Select value={f.currency} onChange={(e) => set({ currency: e.target.value })} {...p}><option>EGP</option><option>USD</option><option>AED</option><option>SAR</option></Select>}</Field>
        </div>
        <Field label="Delivery">{(p) => <Select value={f.delivery} onChange={(e) => set({ delivery: e.target.value as Course["delivery"] })} {...p}>{Object.entries(DELIVERY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
        <div className="grid grid-cols-3 gap-3 sm:col-span-2">
          <Field label="Sessions">{(p) => <Input type="number" min={1} value={f.sessionsCount} onChange={(e) => set({ sessionsCount: e.target.value })} {...p} />}</Field>
          <Field label="Hours per session">{(p) => <Input type="number" min={0.5} step={0.5} value={f.sessionHours} onChange={(e) => set({ sessionHours: e.target.value })} {...p} />}</Field>
          <Field label="Duration (weeks)">{(p) => <Input type="number" min={1} value={f.durationWeeks} onChange={(e) => set({ durationWeeks: e.target.value })} {...p} />}</Field>
        </div>
        <Field label="Starts">{(p) => <Input type="date" value={f.startDate} onChange={(e) => set({ startDate: e.target.value })} {...p} />}</Field>
        <Field label="Ends">{(p) => <Input type="date" min={f.startDate || undefined} value={f.endDate} onChange={(e) => set({ endDate: e.target.value })} {...p} />}</Field>
        <Field label="Schedule">{(p) => <Input value={f.schedule} maxLength={200} onChange={(e) => set({ schedule: e.target.value })} placeholder="Sun, Tue, Thu 7–9 pm" {...p} />}</Field>
        <Field label="Capacity (students)">{(p) => <Input type="number" min={1} value={f.capacity} onChange={(e) => set({ capacity: e.target.value })} {...p} />}</Field>
        <Field label="Details" className="sm:col-span-2" hint="What is included, level, materials… Agents see this when talking to customers.">
          {(p) => <Textarea value={f.description} maxLength={2000} onChange={(e) => set({ description: e.target.value })} {...p} />}
        </Field>
        <label className="flex items-center gap-3 text-sm sm:col-span-2"><Toggle label="Open for new leads and enrollments" checked={f.active} onChange={(v) => set({ active: v })} /> Open for new leads and enrollments</label>
      </div>
    </Dialog>
  );
}

function CourseTypeDialog({ type, onClose }: { type: Partial<CourseType>; onClose: () => void }) {
  const runAction = useRunAction();
  const [f, setF] = useState({ name: type.name ?? "", description: type.description ?? "", color: (type.color ?? "blue") as TagColor });
  return (
    <Dialog open onClose={onClose} title={type.id ? "Edit course type" : "Add course type"}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => { const r = await runAction(saveCourseType({ id: type.id, ...f }), "Course type saved", { reference: true }); if (r.ok) onClose(); }}>Save</Button></>}>
      <div className="space-y-4">
        <Field label="Name" required>{(p) => <Input value={f.name} maxLength={60} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Private 1:1" {...p} />}</Field>
        <Field label="Description">{(p) => <Input value={f.description} maxLength={300} onChange={(e) => setF({ ...f, description: e.target.value })} {...p} />}</Field>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium">Color</legend>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(TAG_COLORS) as TagColor[]).map((c) => (
              <button key={c} type="button" aria-pressed={f.color === c} onClick={() => setF({ ...f, color: c })}
                className={clsx("flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs", f.color === c ? "border-navy-900" : "border-line")}>
                <span className="h-3 w-3 rounded-full" style={{ background: TAG_COLORS[c].dot }} aria-hidden /> {TAG_COLORS[c].label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}
