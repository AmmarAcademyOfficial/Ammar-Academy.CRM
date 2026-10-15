import { apiRoute } from "@/server/api";
import { distribution } from "@/server/import-queries";
import { forbidden } from "@/server/result";

export async function GET() {
  return apiRoute(async (staff) => {
    if (staff.role !== "manager") forbidden();
    return distribution(staff);
  });
}
