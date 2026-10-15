import { z } from "zod";
import { apiRoute } from "@/server/api";
import { getLeadDetail } from "@/server/queries";

export async function GET(_req: Request, ctx: RouteContext<"/api/leads/[id]">) {
  const { id } = await ctx.params;
  return apiRoute(async (staff) => (z.string().uuid().safeParse(id).success ? getLeadDetail(staff, id) : null));
}
