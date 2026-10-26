import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiRoute } from "@/server/api";
import { leadFiltersSchema as filters } from "@/server/lead-filter-schema";
import { listLeads } from "@/server/queries";


const query = z.object({
  filters,
  sort: z.object({ key: z.enum(["name", "program", "stage", "outcome", "followup", "owner", "lastContact", "created"]), dir: z.enum(["asc", "desc"]) }),
  page: z.number().int().min(0).max(10_000),
  pageSize: z.number().int().min(5).max(100),
});

export async function GET(req: NextRequest) {
  return apiRoute(async (staff) => {
    const parsed = query.safeParse(JSON.parse(req.nextUrl.searchParams.get("q") ?? "{}"));
    if (!parsed.success) throw Object.assign(new Error("Invalid filters"), { code: "CRM01", message: "Those filters are not valid." });
    // A sales agent's owner filter is ignored: they only ever see their own leads anyway.
    return listLeads(staff, parsed.data);
  });
}
