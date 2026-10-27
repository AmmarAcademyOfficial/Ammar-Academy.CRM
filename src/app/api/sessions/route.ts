import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiRoute } from "@/server/api";
import { forbidden } from "@/server/result";
import { sessionsData } from "@/server/session-queries";

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Sessions for support and managers. */
export async function GET(req: NextRequest) {
  return apiRoute(async (staff) => {
    if (staff.role === "sales") forbidden("Sessions are for support, managers and the accountant.");
    const p = req.nextUrl.searchParams;
    return sessionsData(staff, isoDay.parse(p.get("from")), isoDay.parse(p.get("to")));
  });
}
