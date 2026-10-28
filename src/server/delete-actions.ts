"use server";

/**
 * CRM changes plan 3, release 2: delete payments, enrollments, leads and customers, and restore them
 * from Deleted items for 30 days. The database checks the role and every rule (reason, the word
 * DELETE for confirmed money, closed salary months).
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { DeleteKind, DeletePreview } from "@/domain/dto";
import { requireStaff } from "./auth";
import { asUser } from "./db";
import { attempt, type Result } from "./result";

const uuid = z.string().uuid();
const kind = z.enum(["payment", "enrollment", "lead", "customer", "teacher", "rate"]);
// Teachers and rates live in the reference data every screen loads once.
const refreshReference = (k: DeleteKind) => (k === "teacher" || k === "rate") && revalidatePath("/", "layout");

export async function previewDelete(k: DeleteKind, id: string): Promise<Result<DeletePreview>> {
  return attempt(async () => {
    const staff = await requireStaff();
    const [{ r }] = await asUser(staff.id, (tx) => tx<{ r: DeletePreview }[]>`select public.delete_preview(${kind.parse(k)}, ${uuid.parse(id)}) as r`);
    return r;
  });
}

export async function deleteRecord(input: { kind: DeleteKind; id: string; reason: string; confirm?: string }): Promise<Result<{ summary: string; flagged: boolean }>> {
  return attempt(async () => {
    const v = z.object({ kind, id: uuid, reason: z.string().max(500), confirm: z.string().max(20).optional() }).parse(input);
    const staff = await requireStaff();
    const [{ r }] = await asUser(staff.id, (tx) => tx<{ r: { summary: string; flagged: boolean } }[]>`select public.delete_record(${tx.json(v)}) as r`);
    refreshReference(v.kind);
    return r;
  });
}

export async function restoreDeleted(id: string): Promise<Result<{ kind: DeleteKind; inquiryId: string | null; queued: number }>> {
  return attempt(async () => {
    const staff = await requireStaff();
    const [{ r }] = await asUser(staff.id, (tx) => tx<{ r: { kind: DeleteKind; inquiryId: string | null; queued: number } }[]>`select public.restore_deleted(${uuid.parse(id)}) as r`);
    refreshReference(r.kind);
    return r;
  });
}
