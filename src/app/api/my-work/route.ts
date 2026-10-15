import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiRoute } from "@/server/api";
import { myWork } from "@/server/queries";

export async function GET(req: NextRequest) {
  const bucket = z.enum(["overdue", "today", "uncontacted", "new", "payment", "noaction"]).catch("overdue").parse(req.nextUrl.searchParams.get("bucket"));
  return apiRoute((staff) => myWork(staff, bucket));
}
