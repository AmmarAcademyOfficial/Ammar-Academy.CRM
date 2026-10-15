import { apiRoute } from "@/server/api";
import { listNotifications } from "@/server/queries";

export async function GET() {
  return apiRoute((staff) => listNotifications(staff));
}
