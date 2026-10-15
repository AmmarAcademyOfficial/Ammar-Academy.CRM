import { apiRoute } from "@/server/api";
import { decryptSecret } from "@/server/crypto";
import { asSystem } from "@/server/db";
import { env } from "@/server/env";
import { accessTokenFor } from "@/server/google";
import { fakeFiles } from "@/server/google/fake";
import { forbidden } from "@/server/result";

/** What the browser needs to open Google's file picker (a short-lived token limited to drive.file). */
export async function GET() {
  return apiRoute(async (staff) => {
    if (staff.role !== "manager") forbidden();
    const e = env();
    if (e.GOOGLE_MODE === "fake") return { mode: "fake" as const, files: fakeFiles(e.FAKE_GOOGLE_FILE) };
    if (e.GOOGLE_MODE !== "real") return { mode: "off" as const };
    const [acc] = await asSystem((tx) => tx<{ id: string; refresh_token_enc: string }[]>`
      select id, refresh_token_enc from public.google_accounts where status = 'connected' and refresh_token_enc is not null
      order by connected_at desc limit 1`);
    if (!acc) return { mode: "real" as const, connected: false };
    const accessToken = await accessTokenFor(acc.id, decryptSecret(acc.refresh_token_enc));
    return { mode: "real" as const, connected: true, accessToken, apiKey: e.GOOGLE_PICKER_API_KEY!, appId: e.GOOGLE_PROJECT_NUMBER! };
  });
}
