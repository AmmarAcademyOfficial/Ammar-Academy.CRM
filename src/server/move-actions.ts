"use server";

/** Moving leads in bulk (managers; the database checks the role and every lead). */
import { z } from "zod";
import { requireStaff } from "./auth";
import { asUser } from "./db";
import { attempt, type Result, ValidationError } from "./result";

export interface MoveResult {
  moved: number;
  queued: number;
  skipped: number;
  agents: { id: string; name: string; received: number; open: number; cap: number | null }[];
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0].message, r.error.issues.map((i) => i.message));
  return r.data;
}
const reason = z.string().trim().min(1, 'Add a reason, for example "Nour is on leave this week".').max(300);

const moveSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, "Choose at least one lead.").max(500, "Move up to 500 leads at a time."),
  mode: z.enum(["to", "share", "queue"]),
  to: z.array(z.string().uuid()).max(20),
  reason,
});

export async function moveLeads(input: z.input<typeof moveSchema>): Promise<Result<MoveResult>> {
  return attempt(async () => {
    const v = parse(moveSchema, input);
    const staff = await requireStaff();
    const [{ r }] = await asUser(staff.id, (tx) => tx<{ r: MoveResult }[]>`select public.move_leads(${tx.json({ ids: v.ids, mode: v.mode, to: v.to, reason: v.reason })}) as r`);
    return r;
  });
}

const swapSchema = z.object({
  agentA: z.string().uuid(),
  agentB: z.string().uuid(),
  aIds: z.array(z.string().uuid()).max(500),
  bIds: z.array(z.string().uuid()).max(500),
  reason,
});

export async function swapLeads(input: z.input<typeof swapSchema>): Promise<Result<MoveResult>> {
  return attempt(async () => {
    const v = parse(swapSchema, input);
    if (v.aIds.length + v.bIds.length > 500) throw new ValidationError("Swap up to 500 leads at a time.", []);
    const staff = await requireStaff();
    const [{ r }] = await asUser(staff.id, (tx) => tx<{ r: MoveResult }[]>`select public.swap_leads(${tx.json({ agent_a: v.agentA, agent_b: v.agentB, a_ids: v.aIds, b_ids: v.bIds, reason: v.reason })}) as r`);
    return r;
  });
}
