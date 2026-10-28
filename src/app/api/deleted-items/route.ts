import type { DeletedItem } from "@/domain/dto";
import { apiRoute } from "@/server/api";
import { asUser } from "@/server/db";
import { forbidden } from "@/server/result";

/** Deleted items that can still be restored (managers: all; the accountant: payments they deleted). */
export async function GET() {
  return apiRoute(async (staff) => {
    if (staff.role !== "manager" && staff.role !== "accountant") forbidden("Deleted items are for managers and the accountant.");
    const [{ r }] = await asUser(staff.id, (tx) => tx<{ r: DeletedItem[] }[]>`select public.deleted_items() as r`);
    return { items: r };
  });
}
