import { z } from "zod";
import { getStaff } from "@/server/auth";
import { asUser } from "@/server/db";
import { getReceipt } from "@/server/storage";

/**
 * Opens a receipt if the signed-in person may see that payment (row-level security), or for
 * accountants, through the finance-only function (they have no row access to payments).
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/receipts/[paymentId]">) {
  const staff = await getStaff();
  if (!staff) return new Response("Sign in again.", { status: 401 });
  const { paymentId } = await ctx.params;
  if (!z.string().uuid().safeParse(paymentId).success) return new Response("Not found", { status: 404 });
  const [p] = await asUser(staff.id, (tx) => staff.role === "accountant"
    ? tx<{ receipt_path: string | null; receipt_mime: string; receipt_name: string }[]>`select * from public.accounting_receipt(${paymentId})`
    : tx<{ receipt_path: string | null; receipt_mime: string; receipt_name: string }[]>`
    select receipt_path, receipt_mime, receipt_name from public.payments where id = ${paymentId}`);
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
