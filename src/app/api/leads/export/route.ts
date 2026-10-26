import { z } from "zod";
import { exportRoute, leadsWorkbook } from "@/server/exports";
import { leadFiltersSchema } from "@/server/lead-filter-schema";
import { forbidden } from "@/server/result";

const body = z.object({
  filters: leadFiltersSchema,
  sort: z.object({ key: z.enum(["name", "program", "stage", "outcome", "followup", "owner", "lastContact", "created"]), dir: z.enum(["asc", "desc"]) }),
});

/** Download the Leads list as Excel: exactly what the filters show, up to 20,000 rows (managers only; logged). */
export async function POST(req: Request) {
  return exportRoute(async (staff) => {
    if (staff.role !== "manager") forbidden("Only managers can download leads.");
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw Object.assign(new Error("Invalid filters"), { code: "CRM01", message: "Those filters are not valid." });
    return leadsWorkbook(staff, parsed.data);
  });
}
