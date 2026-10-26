"use server";

/** Adding an existing customer (managers and support; the database checks the role and every value). */
import { z } from "zod";
import { normalizePhone } from "@/domain/rules";
import { requireStaff } from "./auth";
import { asUser } from "./db";
import { attempt, type Result, ValidationError } from "./result";
import { readReceiptToken } from "./storage";

export interface PhoneMatch {
  contactId: string;
  name: string;
  inquiries: { inquiryId: string; program: string; student: string | null; stage: string; course: string | null }[];
}

/** Who already has this phone, if anyone. */
export async function lookupContactByPhone(raw: string): Promise<Result<PhoneMatch | null>> {
  return attempt(async () => {
    const staff = await requireStaff();
    const phone = normalizePhone(raw);
    if (!/^\+?\d{8,15}$/.test(phone)) return null;
    const [{ r }] = await asUser(staff.id, (tx) => tx<{ r: PhoneMatch | null }[]>`select public.lookup_contact_by_phone(${phone}) as r`);
    return r;
  });
}

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date.");
const money = z.coerce.number().positive().max(10_000_000);
const schema = z.object({
  contactId: uuid.optional(),
  name: z.string().trim().max(120).optional(),
  phone: z.string().max(40).optional(),
  contactType: z.enum(["student", "parent", "other"]).optional(),
  studentName: z.string().trim().max(120).optional(),
  programId: uuid,
  courseId: uuid,
  agreedTotal: money,
  priceNote: z.string().trim().max(300).optional(),
  enrolledOn: day,
  salesAgentId: uuid.optional(),
  supportOwnerId: uuid.optional(),
  status: z.enum(["onboarding", "active"]),
  packageHoursBefore: z.coerce.number().min(0).max(1000).optional(),
  payments: z.array(z.object({
    amount: money, paidOn: day, method: z.enum(["bank_transfer", "instapay", "mobile_wallet", "cash", "card", "other"]),
    kind: z.enum(["deposit", "installment", "full"]), reference: z.string().trim().max(100).optional(), receiptToken: z.string().max(4000).optional(),
  })).max(50),
  dues: z.array(z.object({ dueOn: day, amount: money })).max(50),
  teacher: z.object({ teacherId: uuid, rateId: uuid, subject: z.string().trim().max(60).optional() }).optional(),
});

export async function addExistingCustomer(input: z.input<typeof schema>): Promise<Result<{ inquiryId: string; pending: number }>> {
  return attempt(async () => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message, parsed.error.issues.map((i) => i.message));
    const v = parsed.data;
    const staff = await requireStaff();
    const payments = v.payments.map((p, i) => {
      const receipt = p.receiptToken ? readReceiptToken(p.receiptToken, staff.id) : null;
      if (p.receiptToken && !receipt) throw new ValidationError(`Payment ${i + 1}: the uploaded receipt expired. Please attach it again.`);
      return { amount: p.amount, paid_on: p.paidOn, method: p.method, kind: p.kind, reference: p.reference || null, receipt };
    });
    const phone = v.phone ? normalizePhone(v.phone) : "";
    const [{ r }] = await asUser(staff.id, (tx) => tx<{ r: { inquiry_id: string; pending: number } }[]>`select public.add_existing_customer(${tx.json({
      contact_id: v.contactId ?? null, name: v.name ?? null, phone: v.phone ?? null, phone_normalized: phone || null, contact_type: v.contactType ?? null,
      student_name: v.studentName || null, program_id: v.programId, course_id: v.courseId, agreed_total: v.agreedTotal, price_note: v.priceNote || null,
      enrolled_on: v.enrolledOn, sales_agent_id: v.salesAgentId ?? null, support_owner_id: v.supportOwnerId ?? null, status: v.status,
      package_hours_before: v.packageHoursBefore ?? 0, payments: payments as never,
      dues: v.dues.map((d) => ({ due_on: d.dueOn, amount: d.amount })),
      teacher: v.teacher ? { teacher_id: v.teacher.teacherId, rate_id: v.teacher.rateId, subject: v.teacher.subject || null } : null,
    })}) as r`);
    return { inquiryId: r.inquiry_id, pending: Number(r.pending) };
  });
}
