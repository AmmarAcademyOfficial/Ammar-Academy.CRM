import "server-only";
import type { AccountingCustomer, AccountingData, AccountingPayment } from "@/domain/dto";
import type { Staff } from "./auth";
import { asUser } from "./db";
import { mapPayment } from "./mappers";

/**
 * Accounting reads (managers and accountants). Both go through finance-only database functions,
 * which check the role and return names and amounts only (no phone numbers).
 */
type Row = Record<string, unknown>;

const id = (v: unknown) => (v === null || v === undefined ? null : String(v));
/** node-postgres reads a `date` as local midnight; keep it as the calendar day it is. */
const day = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  return String(v).slice(0, 10);
};

export async function accountingData(staff: Staff, from: string, to: string): Promise<AccountingData> {
  return asUser(staff.id, async (tx) => {
    const [pays, custs] = await Promise.all([
      tx<Row[]>`select * from public.accounting_payments(${from}::date, ${to}::date)`,
      tx<Row[]>`select * from public.accounting_customers()`,
    ]);
    const payments = pays.map((r): AccountingPayment => ({
      payment: { ...mapPayment({ ...r, enrollment_id: r.enrollment_id, receipt_path: r.has_receipt ? "x" : null }), paidOn: day(r.paid_on)! },
      currency: String(r.currency),
      enrollmentId: String(r.enrollment_id),
      inquiryId: String(r.inquiry_id),
      customerName: String(r.customer_name),
      studentName: (r.student_name as string | null) ?? undefined,
      programId: String(r.program_id),
      courseId: String(r.course_id),
      courseTypeId: id(r.course_type_id),
      salesAgentId: id(r.sales_agent_id),
      supportOwnerId: id(r.support_owner_id),
    }));
    const customers = custs.map((r): AccountingCustomer => {
      const agreed = Number(r.agreed_total);
      const paid = Number(r.paid);
      return {
        enrollmentId: String(r.enrollment_id),
        inquiryId: String(r.inquiry_id),
        customerName: String(r.customer_name),
        studentName: (r.student_name as string | null) ?? undefined,
        programId: String(r.program_id),
        courseId: String(r.course_id),
        courseTypeId: id(r.course_type_id),
        currency: String(r.currency),
        agreed,
        paid,
        pending: Number(r.pending),
        balance: Math.max(agreed - paid, 0),
        enrolledAt: new Date(r.enrolled_at as string).toISOString(),
        handedOverAt: r.handed_over_at ? new Date(r.handed_over_at as string).toISOString() : undefined,
        salesAgentId: id(r.sales_agent_id),
        supportOwnerId: id(r.support_owner_id),
        nextDue: r.next_due_on ? { dueOn: day(r.next_due_on)!, left: Number(r.next_due_left), status: r.next_due_status as NonNullable<AccountingCustomer["nextDue"]>["status"] } : undefined,
        overdueLeft: Number(r.overdue_left),
        overdueSince: day(r.overdue_since),
      };
    });
    return { range: { from, to }, payments, customers };
  });
}
