import "server-only";
import { env } from "../env";
import { fakeGoogle } from "./fake";
import { realGoogle } from "./real";
import type { GoogleApi } from "./types";

export * from "./types";

export function googleEnabled(): boolean {
  return env().GOOGLE_MODE !== "off";
}

export function appUrl(): string {
  return (env().APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function redirectUri(): string {
  return `${appUrl()}/api/google/callback`;
}

let cached: GoogleApi | null = null;
export function google(): GoogleApi {
  if (cached) return cached;
  const e = env();
  if (e.GOOGLE_MODE === "fake") cached = fakeGoogle({ file: e.FAKE_GOOGLE_FILE, appUrl: appUrl() });
  else if (e.GOOGLE_MODE === "real") cached = realGoogle({ clientId: e.GOOGLE_CLIENT_ID!, clientSecret: e.GOOGLE_CLIENT_SECRET! });
  else throw new Error("Google Sheets is not configured (GOOGLE_MODE=off).");
  return cached;
}

// Access tokens last about an hour; reuse them between 2-minute runs.
const tokens = new Map<string, { token: string; until: number }>();
export async function accessTokenFor(accountId: string, refreshToken: string): Promise<string> {
  const hit = tokens.get(accountId);
  if (hit && hit.until > Date.now()) return hit.token;
  const token = await google().accessToken(refreshToken);
  tokens.set(accountId, { token, until: Date.now() + 45 * 60_000 });
  return token;
}
export function forgetAccessToken(accountId: string) {
  tokens.delete(accountId);
}
