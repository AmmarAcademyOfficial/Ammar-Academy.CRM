import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiRoute } from "@/server/api";
import { listCustomers } from "@/server/payment-queries";
import { forbidden } from "@/server/result";

const schema = z.object({
  status: z.enum(["any", "new_customer", "onboarding", "active"]).catch("any"),
  owner: z.union([z.enum(["any", "unclaimed", "mine"]), z.string().uuid()]).catch("any"),
  flaggedOnly: z.coerce.boolean().catch(false),
  search: z.string().max(100).catch(""),
});

/** Handed-over customers: support sees the queue and their own; managers see all. */
export async function GET(req: NextRequest) {
  return apiRoute(async (staff) => {
    if (staff.role === "sales") forbidden("Customer onboarding is for support and managers.");
    const p = req.nextUrl.searchParams;
    return listCustomers(staff, schema.parse({
      status: p.get("status") ?? "any", owner: p.get("owner") ?? "any", flaggedOnly: p.get("flagged") === "1" ? true : undefined, search: p.get("q") ?? "",
    }));
  });
}
