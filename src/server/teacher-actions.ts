"use server";

/**
 * Teachers, hourly rates and teacher assignments. Each change goes through a database function as
 * the signed-in person; the database checks the role (managers manage teachers and rates; managers
 * and a customer's support owner assign private teachers; managers assign group teachers).
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff } from "./auth";
import { asUser, type Tx } from "./db";
import { attempt, type Result, ValidationError } from "./result";

const uuid = z.string().uuid();
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");

async function asMe<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const staff = await requireStaff();
  return asUser(staff.id, fn);
}
const refreshReference = () => revalidatePath("/", "layout");

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0].message, r.error.issues.map((i) => i.message));
  return r.data;
}

const teacherSchema = z.object({
  id: uuid.optional(),
  fullName: z.string().trim().min(1, "Enter the teacher's name.").max(120),
  phone: z.string().max(40).optional(),
  email: z.string().max(200).optional(),
  programIds: z.array(uuid).max(20),
  active: z.boolean(),
  notes: z.string().max(1000).optional(),
});

export async function saveTeacher(input: z.input<typeof teacherSchema>): Promise<Result<string>> {
  return attempt(async () => {
    const v = parse(teacherSchema, input);
    const [{ id }] = await asMe((tx) => tx<{ id: string }[]>`select public.save_teacher(${tx.json({
      id: v.id ?? null, full_name: v.fullName, phone: v.phone ?? null, email: v.email ?? null, program_ids: v.programIds, active: v.active, notes: v.notes ?? null,
    })}) as id`);
    refreshReference();
    return id;
  });
}

const rateSchema = z.object({
  teacherId: uuid,
  name: z.string().trim().min(1, "Name the rate, for example \"SAT private\".").max(60),
  currency: z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code."),
  amount: z.coerce.number().positive("Enter the amount per hour.").max(100000),
  validFrom: isoDay,
});

export async function addTeacherRate(input: z.input<typeof rateSchema>): Promise<Result<string>> {
  return attempt(async () => {
    const v = parse(rateSchema, input);
    const [{ id }] = await asMe((tx) => tx<{ id: string }[]>`select public.add_teacher_rate(${tx.json({
      teacher_id: v.teacherId, name: v.name, currency: v.currency, amount: v.amount, valid_from: v.validFrom,
    })}) as id`);
    refreshReference();
    return id;
  });
}

export async function setTeacherRateAmount(rateId: string, amount: number, validFrom: string): Promise<Result<void>> {
  return attempt(async () => {
    const v = parse(z.object({ rateId: uuid, amount: z.coerce.number().positive("Enter the amount per hour.").max(100000), validFrom: isoDay }), { rateId, amount, validFrom });
    await asMe((tx) => tx`select public.set_teacher_rate_amount(${v.rateId}, ${v.amount}, ${v.validFrom}::date)`);
    refreshReference();
  });
}

export async function setTeacherRateArchived(rateId: string, archived: boolean): Promise<Result<void>> {
  return attempt(async () => {
    await asMe((tx) => tx`select public.set_teacher_rate_archived(${uuid.parse(rateId)}, ${archived})`);
    refreshReference();
  });
}

const assignSchema = z.object({
  teacherId: uuid,
  rateId: uuid,
  enrollmentId: uuid.optional(),
  courseId: uuid.optional(),
  subject: z.string().max(60).optional(),
  startedOn: isoDay,
});

export async function assignTeacher(input: z.input<typeof assignSchema>): Promise<Result<string>> {
  return attempt(async () => {
    const v = parse(assignSchema, input);
    const [{ id }] = await asMe((tx) => tx<{ id: string }[]>`select public.assign_teacher(${tx.json({
      teacher_id: v.teacherId, rate_id: v.rateId, enrollment_id: v.enrollmentId ?? null, course_id: v.courseId ?? null,
      subject: v.subject?.trim() || null, started_on: v.startedOn,
    })}) as id`);
    if (v.courseId) refreshReference();
    return id;
  });
}

export async function endTeacherAssignment(id: string, endedOn: string): Promise<Result<void>> {
  return attempt(async () => {
    await asMe((tx) => tx`select public.end_teacher_assignment(${uuid.parse(id)}, ${isoDay.parse(endedOn)}::date)`);
    refreshReference();
  });
}
