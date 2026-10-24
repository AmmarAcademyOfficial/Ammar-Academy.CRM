import type { NextRequest } from "next/server";
import { z } from "zod";
import type { SalaryReport } from "@/domain/dto";
import { apiRoute } from "@/server/api";
import { asUser } from "@/server/db";
import { forbidden } from "@/server/result";

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** Teacher salaries for one Academy month (managers and accountants; the database checks too). */
export async function GET(req: NextRequest) {
  return apiRoute(async (staff) => {
    if (staff.role !== "manager" && staff.role !== "accountant") forbidden("Salaries are for managers and accountants.");
    const m = month.parse(req.nextUrl.searchParams.get("month"));
    const [{ r }] = await asUser(staff.id, (tx) => tx<{ r: SalaryReport }[]>`select public.salary_report(${m}) as r`);
    return r;
  });
}
