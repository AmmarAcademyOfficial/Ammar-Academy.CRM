import type { NextRequest } from "next/server";
import { apiRoute } from "@/server/api";
import { leadFiltersSchema } from "@/server/lead-filter-schema";
import { leadIdsMatching } from "@/server/queries";
import { forbidden } from "@/server/result";

/** Every lead matching the filters, up to 501 ids (managers: "select all matching" and Move leads). */
export async function GET(req: NextRequest) {
  return apiRoute(async (staff) => {
    if (staff.role !== "manager") forbidden("Only managers move leads.");
    const parsed = leadFiltersSchema.safeParse(JSON.parse(req.nextUrl.searchParams.get("f") ?? "{}"));
    if (!parsed.success) throw Object.assign(new Error("Invalid filters"), { code: "CRM01", message: "Those filters are not valid." });
    return leadIdsMatching(staff, parsed.data);
  });
}
