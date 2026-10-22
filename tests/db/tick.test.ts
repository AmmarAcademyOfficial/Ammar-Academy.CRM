/**
 * The 2-minute tick's lease (22 Oct 2026): only one run at a time, and a run that stopped
 * without finishing (an app instance stopped mid-run) never blocks later ticks for long.
 */
import { afterAll, describe, expect, it } from "vitest";
import { admin, as, closeDb, createUser, expectError } from "./helpers";

const start = async (holder: string, secs = 360) => (await admin<{ ok: boolean }>("select private.try_start_tick($1, $2) as ok", [holder, secs]))[0].ok;
const end = (holder: string) => admin("select private.end_tick($1)", [holder]);

afterAll(closeDb);

describe("tick lease", () => {
  it("one run at a time; the next run goes ahead once the first ends", async () => {
    expect(await start("run-a")).toBe(true);
    expect(await start("run-b")).toBe(false);
    await end("run-b"); // a run that does not hold the lease cannot release it
    expect(await start("run-c")).toBe(false);
    await end("run-a");
    expect(await start("run-d")).toBe(true);
    await end("run-d");
  });

  it("a run that never finished stops blocking once its lease expires", async () => {
    expect(await start("crashed", 1)).toBe(true);
    expect(await start("next")).toBe(false);
    await admin("update private.tick_lease set held_until = now() - interval '1 second' where id = 1");
    expect(await start("next")).toBe(true);
    await end("next");
  });

  it("staff cannot touch the lease", async () => {
    const m = await createUser("manager", "Tick Manager");
    await expectError(as(m, (q) => q("select private.try_start_tick('x', 10)")), "42501");
    await admin("update public.profiles set active = false where id = $1", [m.id]);
  });
});
