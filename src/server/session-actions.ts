"use server";

/** Scheduling and recording teaching sessions (managers and support; the database checks who). */
import { z } from "zod";
import type { SessionStatus } from "@/domain/types";
import { requireStaff } from "./auth";
import { asUser } from "./db";
import { attempt, type Result, ValidationError } from "./result";

const uuid = z.string().uuid();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0].message, r.error.issues.map((i) => i.message));
  return r.data;
}

const scheduleSchema = z.object({
  assignmentId: uuid,
  startsAt: z.string().datetime({ offset: true, message: "Choose the date and time of the session." }),
  plannedHours: z.coerce.number().min(0.25, "Enter the session length in hours.").max(12),
  repeatWeeks: z.coerce.number().int().min(0).max(25),
  note: z.string().max(300).optional(),
});

export async function scheduleSessions(input: z.input<typeof scheduleSchema>): Promise<Result<number>> {
  return attempt(async () => {
    const v = parse(scheduleSchema, input);
    const staff = await requireStaff();
    const [{ n }] = await asUser(staff.id, (tx) => tx<{ n: number }[]>`select public.schedule_sessions(${tx.json({
      assignment_id: v.assignmentId, starts_at: v.startsAt, planned_hours: v.plannedHours, repeat_weeks: v.repeatWeeks, note: v.note ?? null,
    })}) as n`);
    return n;
  });
}

const recordSchema = z.object({
  id: uuid,
  status: z.enum(["scheduled", "done", "cancelled_student", "cancelled_teacher", "no_show"]),
  hours: z.coerce.number().min(0).max(12).optional(),
  late: z.boolean().optional(),
  note: z.string().max(300).optional(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  plannedHours: z.coerce.number().min(0.25).max(12).optional(),
});

export async function recordSession(input: z.input<typeof recordSchema> & { status: SessionStatus }): Promise<Result<{ paidHours: number; studentHours: number }>> {
  return attempt(async () => {
    const v = parse(recordSchema, input);
    const staff = await requireStaff();
    const [{ r }] = await asUser(staff.id, (tx) => tx<{ r: { paid_hours: number; student_hours: number } }[]>`select public.record_session(${tx.json({
      id: v.id, status: v.status, hours: v.hours ?? null, late: v.late ?? false, note: v.note ?? null, starts_at: v.startsAt ?? null, planned_hours: v.plannedHours ?? null,
    })}) as r`);
    return { paidHours: Number(r.paid_hours), studentHours: Number(r.student_hours) };
  });
}

export async function deleteSession(id: string): Promise<Result<void>> {
  return attempt(async () => {
    const staff = await requireStaff();
    await asUser(staff.id, (tx) => tx`select public.delete_session(${uuid.parse(id)})`);
  });
}

export interface SeriesInfo { seriesId: string | null; total: number; following: number; all: number; recorded: number }

/** How many sessions of this session's series a change could reach. */
export async function sessionSeriesInfo(id: string): Promise<Result<SeriesInfo>> {
  return attempt(async () => {
    const staff = await requireStaff();
    const [{ r }] = await asUser(staff.id, (tx) => tx<{ r: SeriesInfo }[]>`select public.session_series_info(${uuid.parse(id)}) as r`);
    return r;
  });
}

const seriesSchema = z.object({
  id: uuid,
  scope: z.enum(["following", "all"]),
  action: z.enum(["move", "remove"]),
  startsAt: z.string().datetime({ offset: true }).optional(),
  plannedHours: z.coerce.number().min(0.25).max(12).optional(),
});

/** Move or remove this and the following sessions, or the whole series (only those still scheduled). */
export async function changeSessionSeries(input: z.input<typeof seriesSchema>): Promise<Result<number>> {
  return attempt(async () => {
    const v = parse(seriesSchema, input);
    const staff = await requireStaff();
    const [{ r }] = await asUser(staff.id, (tx) => tx<{ r: { changed: number } }[]>`select public.change_session_series(${tx.json({
      id: v.id, scope: v.scope, action: v.action, starts_at: v.startsAt ?? null, planned_hours: v.plannedHours ?? null,
    })}) as r`);
    return r.changed;
  });
}
