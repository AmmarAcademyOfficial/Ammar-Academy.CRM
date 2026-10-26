import type { NextRequest } from "next/server";
import type { EnrollmentList } from "@/domain/dto";
import { apiRoute } from "@/server/api";
import { asUser } from "@/server/db";
import { enrollmentListQuerySchema as query } from "@/server/enrollment-filter-schema";
import { forbidden } from "@/server/result";

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
