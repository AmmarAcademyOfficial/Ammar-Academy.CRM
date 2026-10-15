"use server";

/**
 * Courses, enrollments, payments and support onboarding. Every change goes through a
 * database function as the signed-in person; the database checks the role and the rules.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff } from "./auth";
import { asUser, type Tx } from "./db";
import { attempt, type Result, ValidationError } from "./result";
import { readReceiptToken } from "./storage";

const uuid = z.string().uuid();
const money = z.coerce.number().finite().min(0).max(10_000_000);

async function asMe<T>(fn: (tx: Tx, staffId: string) => Promise<T>): Promise<T> {
  const staff = await requireStaff();
  return asUser(staff.id, (tx) => fn(tx, staff.id));
}

const refreshReference = () => revalidatePath("/", "layout");

// ── Courses catalog ──────────────────────────────────────────────────────

export async function saveCourseType(input: { id?: string; name: string; description?: string; color: string }): Promise<Result<string>> {
  return attempt(async () => {
    const v = z.object({
      id: uuid.optional(),
      name: z.string().trim().min(1, "Name the course type.").max(60),
      description: z.string().max(300).optional(),
      color: z.enum(["orange", "blue", "purple", "red", "green", "teal", "gray"]),
    }).parse(input);
    const [{ id }] = await asMe((tx) => tx<{ id: string }[]>`select public.save_course_type(${tx.json(v)}) as id`);
    refreshReference();
    return id;
  });
}

export async function setCourseTypeArchived(id: string, archived: boolean): Promise<Result<void>> {
  return attempt(async () => {
    await asMe((tx) => tx`select public.set_course_type_archived(${uuid.parse(id)}, ${archived})`);
    refreshReference();
  });
}

const courseSchema = z.object({
  id: uuid.optional(),
  programId: uuid,
  courseTypeId: uuid,
  name: z.string().trim().min(1, "Name the course.").max(120),
  price: money.nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code."),
  description: z.string().max(2000).optional(),
  delivery: z.enum(["online", "in_person", "hybrid"]),
  durationWeeks: z.coerce.number().int().min(1).max(104).nullable().optional(),
  sessionsCount: z.coerce.number().int().min(1).max(500).nullable().optional(),
  sessionHours: z.coerce.number().min(0.5).max(12).nullable().optional(),
  schedule: z.string().max(200).optional(),
  startDate: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).optional(),
  endDate: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).optional(),
  capacity: z.coerce.number().int().min(1).max(1000).nullable().optional(),
  active: z.boolean(),
});

export async function saveCourse(input: z.input<typeof courseSchema>): Promise<Result<string>> {
  return attempt(async () => {
    const parsed = courseSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message, parsed.error.issues.map((i) => i.message));
    const v = parsed.data;
    const [{ id }] = await asMe((tx) => tx<{ id: string }[]>`select public.save_course(${tx.json({
      id: v.id ?? null, program_id: v.programId, course_type_id: v.courseTypeId, name: v.name, price: v.price, currency: v.currency,
      description: v.description ?? null, delivery: v.delivery, duration_weeks: v.durationWeeks ?? null, sessions_count: v.sessionsCount ?? null,
      session_hours: v.sessionHours ?? null, schedule: v.schedule ?? null, start_date: v.startDate || null, end_date: v.endDate || null,
      capacity: v.capacity ?? null, active: v.active,
    })}) as id`);
    refreshReference();
    return id;
  });
}

export async function setCourseActive(id: string, active: boolean): Promise<Result<void>> {
  return attempt(async () => {
    await asMe((tx) => tx`select public.set_course_active(${uuid.parse(id)}, ${active})`);
    refreshReference();
  });
}

export async function setInquiryCourse(inquiryId: string, courseId: string | null, expectedVersion?: number): Promise<Result<number>> {
  return attempt(async () => {
    const [{ v }] = await asMe((tx) => tx<{ v: number }[]>`
      select public.set_inquiry_course(${uuid.parse(inquiryId)}, ${courseId ? uuid.parse(courseId) : null}, ${expectedVersion ?? null}) as v`);
    return v;
  });
}

// ── Enrollments and payments ─────────────────────────────────────────────

export async function saveEnrollment(input: { inquiryId: string; courseId: string; agreedTotal: number; priceNote?: string }): Promise<Result<string>> {
  return attempt(async () => {
    const v = z.object({ inquiryId: uuid, courseId: uuid, agreedTotal: money.positive("Enter the agreed total."), priceNote: z.string().max(300).optional() }).parse(input);
    const [{ id }] = await asMe((tx) => tx<{ id: string }[]>`select public.save_enrollment(${tx.json({
      inquiry_id: v.inquiryId, course_id: v.courseId, agreed_total: v.agreedTotal, price_note: v.priceNote ?? null,
    })}) as id`);
    return id;
  });
}

const paymentSchema = z.object({
  enrollmentId: uuid,
  amount: money.positive("Enter the amount paid."),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the payment date."),
  method: z.enum(["bank_transfer", "instapay", "mobile_wallet", "cash", "card", "other"]),
  reference: z.string().max(100).optional(),
  note: z.string().max(1000).optional(),
  receiptToken: z.string().max(4000).optional(),
});

export async function submitPayment(input: z.input<typeof paymentSchema>): Promise<Result<string>> {
  return attempt(async () => {
    const staff = await requireStaff();
    const v = paymentSchema.parse(input);
    const receipt = v.receiptToken ? readReceiptToken(v.receiptToken, staff.id) : null;
    if (v.receiptToken && !receipt) throw new ValidationError("The uploaded receipt expired. Please attach it again.");
    const [{ id }] = await asUser(staff.id, (tx) => tx<{ id: string }[]>`select public.submit_payment(${tx.json({
      enrollment_id: v.enrollmentId, amount: v.amount, paid_on: v.paidOn, method: v.method,
      reference: v.reference ?? null, note: v.note ?? null, receipt: receipt as never,
    })}) as id`);
    return id;
  });
}

export async function decidePayment(paymentId: string, decision: "confirmed" | "rejected", reason?: string): Promise<Result<{ handedOver: boolean; balance: number }>> {
  return attempt(async () => {
    const [{ r }] = await asMe((tx) => tx<{ r: { handed_over: boolean; balance: number } }[]>`
      select public.decide_payment(${uuid.parse(paymentId)}, ${z.enum(["confirmed", "rejected"]).parse(decision)}, ${reason ?? null}) as r`);
    return { handedOver: r.handed_over, balance: Number(r.balance) };
  });
}

export async function reversePayment(paymentId: string, reason: string): Promise<Result<{ flagged: boolean }>> {
  return attempt(async () => {
    const [{ r }] = await asMe((tx) => tx<{ r: { flagged: boolean } }[]>`select public.reverse_payment(${uuid.parse(paymentId)}, ${reason}) as r`);
    return { flagged: r.flagged };
  });
}

// ── Support onboarding ───────────────────────────────────────────────────

export async function claimCustomer(onboardingId: string): Promise<Result<void>> {
  return attempt(async () => {
    await asMe((tx) => tx`select public.claim_onboarding(${uuid.parse(onboardingId)})`);
  });
}

export async function assignCustomer(onboardingId: string, toUserId: string, reason?: string): Promise<Result<void>> {
  return attempt(async () => {
    await asMe((tx) => tx`select public.assign_onboarding(${uuid.parse(onboardingId)}, ${uuid.parse(toUserId)}, ${reason ?? null})`);
  });
}

export async function setChecklistItem(onboardingId: string, itemId: string, done: boolean): Promise<Result<void>> {
  return attempt(async () => {
    await asMe((tx) => tx`select public.set_checklist_item(${uuid.parse(onboardingId)}, ${uuid.parse(itemId)}, ${done})`);
  });
}

export async function setSupportStatus(onboardingId: string, status: "new_customer" | "onboarding" | "active"): Promise<Result<void>> {
  return attempt(async () => {
    await asMe((tx) => tx`select public.set_onboarding_status(${uuid.parse(onboardingId)}, ${z.enum(["new_customer", "onboarding", "active"]).parse(status)}::public.support_status)`);
  });
}

export async function clearCustomerFlag(onboardingId: string, note: string): Promise<Result<void>> {
  return attempt(async () => {
    await asMe((tx) => tx`select public.clear_onboarding_flag(${uuid.parse(onboardingId)}, ${note})`);
  });
}

export async function createSupportFollowUp(onboardingId: string, dueAtIso: string, note: string): Promise<Result<void>> {
  return attempt(async () => {
    const due = z.string().datetime({ offset: true }).parse(dueAtIso);
    await asMe((tx) => tx`select public.create_support_follow_up(${uuid.parse(onboardingId)}, ${due}::timestamptz, ${note})`);
  });
}

export async function completeSupportFollowUp(id: string): Promise<Result<void>> {
  return attempt(async () => {
    await asMe((tx) => tx`select public.complete_support_follow_up(${uuid.parse(id)})`);
  });
}

export async function addSupportNote(onboardingId: string, body: string): Promise<Result<void>> {
  return attempt(async () => {
    await asMe((tx) => tx`select public.add_support_note(${uuid.parse(onboardingId)}, ${body})`);
  });
}

// ── Checklist template ───────────────────────────────────────────────────

export async function saveChecklistStep(input: { id?: string; label: string; dueAfterDays: number | null }): Promise<Result<void>> {
  return attempt(async () => {
    const v = z.object({ id: uuid.optional(), label: z.string().trim().min(1, "Describe the step.").max(120), dueAfterDays: z.number().int().min(0).max(365).nullable() }).parse(input);
    await asMe((tx) => tx`select public.save_checklist_item(${tx.json({ id: v.id ?? null, label: v.label, due_after_days: v.dueAfterDays })})`);
    refreshReference();
  });
}

export async function setChecklistStepArchived(id: string, archived: boolean): Promise<Result<void>> {
  return attempt(async () => {
    await asMe((tx) => tx`select public.set_checklist_item_archived(${uuid.parse(id)}, ${archived})`);
    refreshReference();
  });
}

export async function moveChecklistStep(id: string, dir: -1 | 1): Promise<Result<void>> {
  return attempt(async () => {
    await asMe((tx) => tx`select public.move_checklist_item(${uuid.parse(id)}, ${dir})`);
    refreshReference();
  });
}
