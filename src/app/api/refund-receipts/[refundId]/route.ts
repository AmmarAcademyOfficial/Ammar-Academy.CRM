import { z } from "zod";
import { getStaff } from "@/server/auth";
import { asUser } from "@/server/db";
import { getReceipt } from "@/server/storage";

/** Opens a refund's transfer receipt if the signed-in person may see that customer (plan 3, release 4). */
export async function GET(_req: Request, ctx: RouteContext<"/api/refund-receipts/[refundId]">) {
  const staff = await getStaff();
  if (!staff) return new Response("Sign in again.", { status: 401 });
  const { refundId } = await ctx.params;
  if (!z.string().uuid().safeParse(refundId).success) return new Response("Not found", { status: 404 });
  // Row-level security: the refund is visible only to those who can see the customer.
  const [p] = await asUser(staff.id, (tx) => tx<{ receipt_path: string | null; receipt_mime: string; receipt_name: string }[]>`
    select receipt_path, receipt_mime, receipt_name from public.refunds where id = ${refundId}`);
  if (!p?.receipt_path) return new Response("Not found", { status: 404 });
  const bytes = await getReceipt(p.receipt_path).catch(() => null);
  if (!bytes) return new Response("The receipt file is missing.", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": p.receipt_mime,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(p.receipt_name || "receipt")}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
