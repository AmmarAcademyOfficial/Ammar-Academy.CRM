import type { NextRequest } from "next/server";
import { z } from "zod";
import { accountingData } from "@/server/accounting-queries";
import { apiRoute } from "@/server/api";
import { forbidden } from "@/server/result";

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Accounting: payments paid in the range and every customer's balance (managers and accountants). */
export async function GET(req: NextRequest) {
  return apiRoute(async (staff) => {
    if (staff.role !== "manager" && staff.role !== "accountant") forbidden("Accounting is for managers and accountants.");
    const p = req.nextUrl.searchParams;
    const from = isoDay.parse(p.get("from"));
    const to = isoDay.parse(p.get("to"));
    return accountingData(staff, from, to);
  });
}
