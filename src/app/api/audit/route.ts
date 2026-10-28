import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiRoute } from "@/server/api";
import { auditPage } from "@/server/queries";
import { forbidden } from "@/server/result";

const schema = z.object({
  q: z.string().max(100).catch(""),
  actor: z.union([z.literal(""), z.literal("system"), z.string().uuid()]).catch(""),
  page: z.coerce.number().int().min(0).max(10000).catch(0),
});

/** Audit history of sensitive changes (managers only, read-only). */
export async function GET(req: NextRequest) {
  return apiRoute(async (staff) => {
    if (staff.role !== "manager" && staff.role !== "accountant") forbidden("Only managers and the accountant can see the audit history.");
    const p = req.nextUrl.searchParams;
    return auditPage(staff, schema.parse({ q: p.get("q") ?? "", actor: p.get("actor") ?? "", page: p.get("page") ?? 0 }));
  });
}
