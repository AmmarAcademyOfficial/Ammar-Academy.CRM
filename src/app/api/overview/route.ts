import { apiRoute } from "@/server/api";
import { overview } from "@/server/queries";

export async function GET() {
  return apiRoute(async (staff) => {
    if (staff.role !== "manager") throw Object.assign(new Error(), { code: "CRM03", message: "Only managers can see the overview." });
    return overview(staff);
  });
}
