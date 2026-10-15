import { timingSafeEqual } from "node:crypto";
import { env } from "@/server/env";
import { runTick } from "@/server/sheets/engine";
import { cleanupOrphanReceipts } from "@/server/storage";

export const maxDuration = 300;

/**
 * The 2-minute heartbeat: syncs every Google Sheet connection, then assigns
 * waiting leads. Called by the scheduler (Supabase pg_cron + pg_net) with
 * "Authorization: Bearer <CRON_SECRET>". Safe to call more often: overlapping
 * runs skip, and the row ledger prevents double imports.
 */
async function handle(req: Request) {
  const secret = env().CRON_SECRET;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return Response.json({ error: "Not allowed" }, { status: 401 });
  }
  try {
    // Manual housekeeping run (normally done by the tick once an hour).
    if (new URL(req.url).searchParams.get("task") === "cleanup") return Response.json({ cleanup: await cleanupOrphanReceipts() });
    const r = await runTick();
    return Response.json({
      ran: r.ran,
      ms: r.ms,
      assignment: r.assignment,
      cleanup: r.cleanup,
      connections: r.connections.map((c) => ({ id: c.connectionId, status: c.status, imported: c.imported, resubmitted: c.resubmitted, review: c.review, failed: c.failed, remaining: c.remaining })),
    });
  } catch (e) {
    console.error("[cron] tick failed", e);
    return Response.json({ error: "Tick failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
