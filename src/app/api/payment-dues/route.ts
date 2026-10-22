import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiRoute } from "@/server/api";
import { paymentDues } from "@/server/payment-queries";
import { forbidden } from "@/server/result";

const schema = z.object({
  days: z.coerce.number().int().min(0).max(60).catch(7),
  owner: z.union([z.enum(["any", "mine"]), z.string().uuid()]).catch("any"),
});

/** Planned payments that are overdue or due soon: support sees their own customers, managers everyone. */
export async function GET(req: NextRequest) {
  return apiRoute(async (staff) => {
    if (staff.role === "sales") forbidden("Payments due is for support and managers.");
    const p = req.nextUrl.searchParams;
    return paymentDues(staff, schema.parse({ days: p.get("days") ?? 7, owner: p.get("owner") ?? "any" }));
  });
}
