import type { NextRequest } from "next/server";
import { apiRoute } from "@/server/api";
import { reviewItems } from "@/server/import-queries";
import { forbidden } from "@/server/result";

export async function GET(req: NextRequest) {
  return apiRoute(async (staff) => {
    if (staff.role !== "manager") forbidden();
    return reviewItems(staff, req.nextUrl.searchParams.get("status") === "done" ? "done" : "open");
  });
}
