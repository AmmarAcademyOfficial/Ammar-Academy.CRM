import { apiRoute } from "@/server/api";
import { sheetsPage } from "@/server/import-queries";
import { forbidden } from "@/server/result";

export async function GET() {
  return apiRoute(async (staff) => {
    if (staff.role !== "manager") forbidden();
    return sheetsPage(staff);
  });
}
