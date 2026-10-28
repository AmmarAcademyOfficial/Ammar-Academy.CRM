import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiRoute } from "@/server/api";
import { forbidden } from "@/server/result";
import { getReport } from "@/server/report-queries";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const schema = z.object({
  from: day,
  to: day,
  programId: z.string().uuid().optional(),
  courseTypeId: z.string().uuid().optional(),
});

/** Reports (managers only). Dates are Cairo calendar days, both inclusive. */
export async function GET(req: NextRequest) {
  return apiRoute(async (staff) => {
    if (staff.role !== "manager" && staff.role !== "accountant") forbidden("Only managers and the accountant can see reports.");
    const p = req.nextUrl.searchParams;
    const parsed = schema.safeParse({
      from: p.get("from"), to: p.get("to"),
      programId: p.get("program") || undefined, courseTypeId: p.get("courseType") || undefined,
    });
    if (!parsed.success) throw Object.assign(new Error("Choose a valid date range."), { code: "CRM01" });
    return getReport(staff, parsed.data);
  });
}
