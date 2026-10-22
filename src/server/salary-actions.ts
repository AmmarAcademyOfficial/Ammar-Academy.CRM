"use server";

/**
 * Teacher salaries (phase 5). Managers and accountants add bonus/deduction lines; only managers close
 * and reopen a month. Every change goes through a database function as the signed-in person.
 */
import { z } from "zod";
import { requireStaff } from "./auth";
import { asUser } from "./db";
import { attempt, type Result, ValidationError } from "./result";

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose a month.");

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0].message, r.error.issues.map((i) => i.message));
  return r.data;
}

const adjustmentSchema = z.object({
  id: z.string().uuid().optional(),
  month,
  teacherId: z.string().uuid("Choose a teacher."),
  kind: z.enum(["bonus", "deduction"], { message: "Choose bonus or deduction." }),
  amount: z.coerce.number().positive("Enter the amount.").max(1_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/, "Choose the currency."),
  note: z.string().trim().min(1, 'Add a short reason, for example "Extra mock exam".').max(300),
});

export async function saveSalaryAdjustment(input: z.input<typeof adjustmentSchema>): Promise<Result<string>> {
  return attempt(async () => {
    const v = parse(adjustmentSchema, input);
    const staff = await requireStaff();
    const [{ id }] = await asUser(staff.id, (tx) => tx<{ id: string }[]>`select public.save_salary_adjustment(${tx.json({
      id: v.id ?? null, month: v.month, teacher_id: v.teacherId, kind: v.kind, amount: v.amount, currency: v.currency, note: v.note,
    })}) as id`);
    return id;
  });
}

export async function deleteSalaryAdjustment(id: string): Promise<Result<void>> {
  return attempt(async () => {
    const staff = await requireStaff();
    await asUser(staff.id, (tx) => tx`select public.delete_salary_adjustment(${z.string().uuid().parse(id)})`);
  });
}

export async function closeSalaryMonth(m: string): Promise<Result<void>> {
  return attempt(async () => {
    const v = parse(month, m);
    const staff = await requireStaff();
    await asUser(staff.id, (tx) => tx`select public.close_salary_month(${v})`);
  });
}

export async function reopenSalaryMonth(m: string, reason: string): Promise<Result<void>> {
  return attempt(async () => {
    const v = parse(month, m);
    const r = parse(z.string().trim().min(1, "Add a short reason for reopening.").max(300), reason);
    const staff = await requireStaff();
    await asUser(staff.id, (tx) => tx`select public.reopen_salary_month(${v}, ${r})`);
  });
}
