import type { ReviewQueue } from "@/domain/dto";
import { apiRoute } from "@/server/api";
import { asUser } from "@/server/db";
import { forbidden } from "@/server/result";

/** Enrollments waiting for the accountant's or a manager's review, and payments waiting for confirmation (Phase 1). */
export async function GET() {
  return apiRoute(async (staff) => {
    if (staff.role !== "manager" && staff.role !== "accountant") forbidden("The review list is for managers and the accountant.");
    const [{ r }] = await asUser(staff.id, (tx) => tx<{ r: ReviewQueue }[]>`select public.review_queue() as r`);
    return r;
  });
}
