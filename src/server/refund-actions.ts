"use server";

/**
 * Refunds (plan 3, release 4). Support and sales request; managers and the accountant record or
 * decline. The database checks the role and every rule (amount, date, reference, reason, outcome).
 */
import { z } from "zod";
import { requireStaff } from "./auth";
import { asUser } from "./db";
import { attempt, type Result, ValidationError } from "./result";
import { readReceiptToken } from "./storage";

const uuid = z.string().uuid();
const money = z.coerce.number().finite().positive("Enter the amount.").max(10_000_000);
const reason = z.enum(["withdrew", "course_changed", "overpaid", "goodwill", "other"]);

const requestSchema = z.object({ enrollmentId: uuid, amount: money, reason, note: z.string().max(500).optional() });

export async function requestRefund(input: z.input<typeof requestSchema>): Promise<Result<string>> {
  return attempt(async () => {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
    const v = parsed.data;
    const staff = await requireStaff();
    const [{ id }] = await asUser(staff.id, (tx) => tx<{ id: string }[]>`select public.request_refund(${tx.json({
      enrollment_id: v.enrollmentId, amount: v.amount, reason: v.reason, note: v.note ?? null,
    })}) as id`);
    return id;
  });
}

const recordSchema = z.object({
  requestId: uuid.optional(),
  enrollmentId: uuid,
  amount: money,
  refundedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date the money was paid back."),
  method: z.enum(["bank_transfer", "instapay", "mobile_wallet", "cash", "card", "other"]),
  reference: z.string().max(100).optional(),
  receiptToken: z.string().max(4000).optional(),
  reason,
  note: z.string().max(500).optional(),
  outcome: z.enum(["withdraw", "keep"]),
});

export interface RecordedRefund { id: string; withdrawn: boolean; sessionsRemoved: number; duesCancelled: number; flagged: boolean }

export async function recordRefund(input: z.input<typeof recordSchema>): Promise<Result<RecordedRefund>> {
  return attempt(async () => {
    const parsed = recordSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
    const v = parsed.data;
    const staff = await requireStaff();
    const receipt = v.receiptToken ? readReceiptToken(v.receiptToken, staff.id) : null;
    if (v.receiptToken && !receipt) throw new ValidationError("The uploaded receipt expired. Please attach it again.");
    const [{ r }] = await asUser(staff.id, (tx) => tx<{ r: RecordedRefund }[]>`select public.record_refund(${tx.json({
      request_id: v.requestId ?? null, enrollment_id: v.enrollmentId, amount: v.amount, refunded_on: v.refundedOn, method: v.method,
      reference: v.reference ?? null, receipt: receipt as never, reason: v.reason, note: v.note ?? null, outcome: v.outcome,
    })}) as r`);
    return r;
  });
}

export async function declineRefund(id: string, why: string): Promise<Result<void>> {
  return attempt(async () => {
    const staff = await requireStaff();
    await asUser(staff.id, (tx) => tx`select public.decline_refund(${uuid.parse(id)}, ${why})`);
  });
}
