import type { NextRequest } from "next/server";
import { z } from "zod";
import type { EnrollmentList } from "@/domain/dto";
import { apiRoute } from "@/server/api";
import { asUser } from "@/server/db";
import { forbidden } from "@/server/result";

const uuid = z.string().uuid();
const day = z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).default("");
const query = z.object({
  filters: z.object({
    search: z.string().max(100).default(""),
    programIds: z.array(uuid).max(50).default([]),
    courseTypeIds: z.array(uuid).max(50).default([]),
    courseIds: z.array(uuid).max(200).default([]),
    teacherIds: z.array(uuid).max(100).default([]),
    salesAgentIds: z.array(z.union([uuid, z.literal("none")])).max(100).default([]),
    supportOwnerIds: z.array(z.union([uuid, z.literal("none")])).max(100).default([]),
    statuses: z.array(z.enum(["not_handed_over", "new_customer", "onboarding", "active", "flagged"])).default([]),
    paymentStates: z.array(z.enum(["paid", "balance", "overdue", "pending", "none"])).default([]),
    currency: z.string().regex(/^([A-Z]{3})?$/).default(""),
    enrolledFrom: day, enrolledTo: day, startFrom: day, startTo: day,
  }),
  scope: z.enum(["mine", "all"]).optional(),
  sort: z.object({ key: z.enum(["customer", "course", "enrolled", "start", "sales", "support", "paid", "balance", "next_due", "overdue", "last_paid"]), dir: z.enum(["asc", "desc"]) }),
  page: z.number().int().min(0).max(10_000),
  pageSize: z.number().int().min(5).max(100),
});

/** The Enrollments list (managers, accountants, support; the database applies each role's view). */
export async function GET(req: NextRequest) {
  return apiRoute(async (staff) => {
    if (staff.role === "sales") forbidden("The customer list is for managers, accountants and support.");
    const parsed = query.safeParse(JSON.parse(req.nextUrl.searchParams.get("q") ?? "{}"));
    if (!parsed.success) throw Object.assign(new Error("Invalid filters"), { code: "CRM01", message: "Those filters are not valid." });
    const [{ r }] = await asUser(staff.id, (tx) => tx<{ r: EnrollmentList }[]>`select public.enrollments_list(${tx.json(parsed.data)}) as r`);
    return r;
  });
}
