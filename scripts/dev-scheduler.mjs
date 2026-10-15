/**
 * Local stand-in for the production scheduler: calls /api/cron/tick every
 * 2 minutes, like Supabase pg_cron does in production (see docs/SCHEDULER.md).
 *   CRON_SECRET=... APP_URL=http://localhost:3000 npm run scheduler
 */
const url = `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/api/cron/tick`;
const secret = process.env.CRON_SECRET;
const everyMs = Number(process.env.TICK_SECONDS ?? 120) * 1000;
if (!secret) {
  console.error("Set CRON_SECRET (the same value the app uses).");
  process.exit(1);
}

async function tick() {
  try {
    const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
    const body = await res.json().catch(() => ({}));
    const imported = (body.connections ?? []).reduce((n, c) => n + c.imported, 0);
    console.log(new Date().toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo" }), res.status,
      body.ran === false ? "skipped (previous run still going)" : `imported ${imported}, assigned ${body.assignment?.assigned ?? 0}, waiting ${body.assignment?.waiting ?? 0}`);
  } catch (e) {
    console.log("tick failed:", e.message);
  }
}

console.log(`Calling ${url} every ${everyMs / 1000}s. Ctrl+C to stop.`);
await tick();
setInterval(tick, everyMs);
