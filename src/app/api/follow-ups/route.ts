import { apiRoute } from "@/server/api";
import { listFollowUps } from "@/server/queries";

export async function GET() {
  return apiRoute((staff) => listFollowUps(staff));
}
