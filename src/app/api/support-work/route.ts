import { apiRoute } from "@/server/api";
import { supportWork } from "@/server/payment-queries";
import { forbidden } from "@/server/result";

export async function GET() {
  return apiRoute(async (staff) => {
    if (staff.role !== "support") forbidden("This list is for customer support.");
    return supportWork(staff);
  });
}
