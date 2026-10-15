"use server";

/** Shifts, leave, rotation order and assignment runs. The database checks that the caller is a manager. */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff } from "./auth";
import { asUser } from "./db";
import { attempt, type Result } from "./result";

const uuid = z.string().uuid();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter times as HH:MM.");

async function asMe<T>(fn: Parameters<typeof asUser<T>>[1]): Promise<T> {
  const staff = await requireStaff();
  return asUser(staff.id, fn);
}

const shiftSchema = z.object({
  id: uuid.optional(),
  userId: uuid,
  weekdays: z.array(z.number().int().min(0).max(6)).min(1, "Choose at least one day."),
  start: time,
  end: time,
  programIds: z.array(uuid).min(1, "Choose at least one program."),
});

/** Saves a shift. Several weekdays at once create one shift per day (editing changes one). */
export async function saveShifts(input: z.infer<typeof shiftSchema>): Promise<Result<void>> {
  return attempt(async () => {
    const v = shiftSchema.parse(input);
    if (v.start === v.end && v.start !== "00:00") throw Object.assign(new Error("Start and end cannot be the same time (use 00:00–00:00 for a full day)."), { code: "CRM01" });
    await asMe(async (tx) => {
      const days = v.id ? v.weekdays.slice(0, 1) : v.weekdays;
      for (const weekday of days) {
        await tx`select public.save_shift(${tx.json({ id: v.id ?? null, user_id: v.userId, weekday, start: v.start, end: v.end, program_ids: v.programIds })})`;
      }
    });
    revalidatePath("/settings/shifts");
  });
}

export async function deleteShift(id: string): Promise<Result<void>> {
  return attempt(async () => {
    await asMe((tx) => tx`select public.delete_shift(${uuid.parse(id)})`);
    revalidatePath("/settings/shifts");
  });
}

export async function copyShifts(fromUserId: string, toUserIds: string[]): Promise<Result<void>> {
  return attempt(async () => {
    await asMe((tx) => tx`select public.copy_shifts(${uuid.parse(fromUserId)}, ${z.array(uuid).min(1).parse(toUserIds)})`);
    revalidatePath("/settings/shifts");
  });
}

export async function addTimeOff(userId: string, startsOn: string, endsOn: string, reason: string): Promise<Result<void>> {
  return attempt(async () => {
    const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose dates.");
    await asMe((tx) => tx`select public.save_time_off(${uuid.parse(userId)}, ${day.parse(startsOn)}, ${day.parse(endsOn)}, ${z.string().max(200).parse(reason)})`);
    revalidatePath("/settings/shifts");
  });
}

export async function removeTimeOff(id: string): Promise<Result<void>> {
  return attempt(async () => {
    await asMe((tx) => tx`select public.delete_time_off(${uuid.parse(id)})`);
    revalidatePath("/settings/shifts");
  });
}

export async function setRotationOrder(userIds: string[]): Promise<Result<void>> {
  return attempt(async () => {
    await asMe((tx) => tx`select public.set_rotation_order(${z.array(uuid).parse(userIds)})`);
    revalidatePath("/", "layout");
  });
}

export async function runAssignmentNow(): Promise<Result<{ assigned: number; waiting: number }>> {
  return attempt(async () => {
    const [{ r }] = await asMe((tx) => tx<{ r: { assigned: number; waiting: number } }[]>`select public.run_assignment() as r`);
    return r;
  });
}

export async function redistributeLeads(userId: string, reason: string): Promise<Result<{ released: number; assigned: number; waiting: number }>> {
  return attempt(async () => {
    const [{ r }] = await asMe((tx) => tx<{ r: { released: number; assigned: number; waiting: number } }[]>`
      select public.redistribute_open_leads(${uuid.parse(userId)}, ${z.string().max(200).parse(reason)}) as r`);
    return r;
  });
}
