import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiRoute } from "@/server/api";
import { listLeads } from "@/server/queries";

const filters = z.object({
  search: z.string().max(100).default(""),
  programIds: z.array(z.string().uuid()).default([]),
  stageKeys: z.array(z.enum(["new", "contacting", "qualified", "awaiting_payment", "enrolled", "lost", "invalid"])).default([]),
  outcomeIds: z.array(z.string().uuid()).default([]),
  tagIds: z.array(z.string().uuid()).default([]),
  primaryColors: z.array(z.enum(["orange", "blue", "purple", "red", "green", "teal", "gray"])).default([]),
  ownerIds: z.array(z.union([z.string().uuid(), z.literal("unassigned")])).default([]),
  courseIds: z.array(z.union([z.string().uuid(), z.literal("none")])).default([]),
  courseTypeIds: z.array(z.string().uuid()).default([]),
  followUp: z.enum(["any", "today", "overdue", "none", "upcoming"]).default("any"),
  uncontactedOnly: z.boolean().default(false),
  dateField: z.enum(["created", "assigned", "followUp", "lastContact"]).default("created"),
  dateFrom: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).default(""),
  dateTo: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).default(""),
});
const query = z.object({
  filters,
  sort: z.object({ key: z.enum(["name", "program", "stage", "outcome", "followup", "owner", "lastContact", "created"]), dir: z.enum(["asc", "desc"]) }),
  page: z.number().int().min(0).max(10_000),
  pageSize: z.number().int().min(5).max(100),
});

export async function GET(req: NextRequest) {
  return apiRoute(async (staff) => {
    const parsed = query.safeParse(JSON.parse(req.nextUrl.searchParams.get("q") ?? "{}"));
    if (!parsed.success) throw Object.assign(new Error("Invalid filters"), { code: "CRM01", message: "Those filters are not valid." });
    // A sales agent's owner filter is ignored: they only ever see their own leads anyway.
    return listLeads(staff, parsed.data);
  });
}
