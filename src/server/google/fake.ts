/**
 * A simulated Google for local review and automated tests (GOOGLE_MODE=fake,
 * localhost database only). Spreadsheets live in a JSON file that is re-read
 * on every call, so a test can append a row or revoke access and the next
 * sync sees it — exactly like a real Google Form adding a response.
 * Nothing here talks to the network.
 */
import { readFileSync } from "node:fs";
import type { Cell } from "@/domain/sheet-rows";
import { GOOGLE_SCOPES, GoogleAuthError, GoogleNotFoundError, type GoogleApi } from "./types";

export interface FakeGoogleData {
  accounts: Record<string, { revoked?: boolean }>;
  spreadsheets: Record<string, { title: string; timeZone: string; deleted?: boolean; tabs: { gid: number; title: string; rows: Cell[][] }[] }>;
}

export function readFakeData(file: string): FakeGoogleData {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as FakeGoogleData;
  } catch {
    return { accounts: {}, spreadsheets: {} };
  }
}

/** Files the simulated Google Picker offers. */
export function fakeFiles(file: string): { id: string; name: string }[] {
  return Object.entries(readFakeData(file).spreadsheets)
    .filter(([, s]) => !s.deleted)
    .map(([id, s]) => ({ id, name: s.title }));
}

export function fakeGoogle(cfg: { file: string; appUrl: string }): GoogleApi {
  const data = () => readFakeData(cfg.file);
  const emailOf = (token: string, prefix: string) => {
    if (!token.startsWith(prefix)) throw new GoogleAuthError();
    const email = token.slice(prefix.length);
    if (data().accounts[email]?.revoked) throw new GoogleAuthError("Google access was revoked. Reconnect the Google account.");
    return email;
  };
  const sheet = (accessToken: string, id: string) => {
    emailOf(accessToken, "fake-access:");
    const s = data().spreadsheets[id];
    if (!s || s.deleted) throw new GoogleNotFoundError("The spreadsheet was deleted or moved to the trash.");
    return s;
  };

  return {
    authUrl(state) {
      return `${cfg.appUrl}/api/google/fake-consent?state=${encodeURIComponent(state)}`;
    },
    async exchangeCode(code) {
      const email = code.replace(/^fake-code:/, "");
      if (!email.includes("@")) throw new GoogleAuthError("Unknown sign-in code.");
      return { email, refreshToken: `fake-refresh:${email}`, scopes: GOOGLE_SCOPES.join(" ") };
    },
    async accessToken(refreshToken) {
      return `fake-access:${emailOf(refreshToken, "fake-refresh:")}`;
    },
    async revoke() {},
    async spreadsheet(accessToken, id) {
      const s = sheet(accessToken, id);
      return { id, title: s.title, timeZone: s.timeZone, tabs: s.tabs.map((t) => ({ gid: t.gid, title: t.title, rows: t.rows.length })) };
    },
    async values(accessToken, id, tabTitle) {
      const tab = sheet(accessToken, id).tabs.find((t) => t.title === tabTitle);
      if (!tab) throw new GoogleNotFoundError(`The tab "${tabTitle}" no longer exists.`);
      return tab.rows;
    },
  };
}
