/**
 * Google OAuth 2.0 + Sheets API over plain HTTPS (no SDK).
 * Configuration is passed in, so this file can be unit-tested with a mocked fetch.
 */
import type { Cell } from "@/domain/sheet-rows";
import { GOOGLE_SCOPES, GoogleAuthError, GoogleNotFoundError, GoogleTransientError, type GoogleApi, type GrantedSignIn, type SpreadsheetInfo } from "./types";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

export interface RealGoogleConfig {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}

/** Quotes a tab title for an A1 range: 'Form Responses 1'!A:ZZ */
export function tabRange(title: string): string {
  return `'${title.replace(/'/g, "''")}'!A1:ZZ`;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export function realGoogle(cfg: RealGoogleConfig): GoogleApi {
  const f = cfg.fetch ?? fetch;

  async function call(url: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await f(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new GoogleTransientError("Could not reach Google. Will try again on the next run.");
    }
    return res;
  }

  async function sheetsGet<T>(accessToken: string, url: string): Promise<T> {
    const res = await call(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.ok) return (await res.json()) as T;
    const body = (await res.json().catch(() => ({}))) as { error?: { status?: string; message?: string } };
    if (res.status === 401) throw new GoogleAuthError();
    if (res.status === 404) throw new GoogleNotFoundError("The spreadsheet was deleted or moved to the trash.");
    if (res.status === 403 && body.error?.status === "PERMISSION_DENIED") {
      throw new GoogleNotFoundError("The CRM can no longer open this spreadsheet. Pick it again with Connect Google Sheet.");
    }
    if (res.status === 429 || res.status >= 500) throw new GoogleTransientError("Google is busy. Will try again on the next run.");
    throw new GoogleTransientError(`Google returned an error (${res.status}): ${body.error?.message ?? "unknown"}`);
  }

  async function token(params: Record<string, string>): Promise<Record<string, string>> {
    const res = await call(TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, string>;
    if (res.ok) return body;
    if (body.error === "invalid_grant" || body.error === "unauthorized_client") throw new GoogleAuthError();
    if (res.status >= 500) throw new GoogleTransientError("Google sign-in is temporarily unavailable.");
    throw new GoogleAuthError(`Google refused the sign-in (${body.error ?? res.status}).`);
  }

  return {
    authUrl(state, redirectUri) {
      const q = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GOOGLE_SCOPES.join(" "),
        access_type: "offline", // a refresh token, so syncing continues without anyone signed in
        prompt: "consent",
        include_granted_scopes: "true",
        state,
      });
      return `${AUTH}?${q}`;
    },

    async exchangeCode(code, redirectUri): Promise<GrantedSignIn> {
      const t = await token({ code, redirect_uri: redirectUri, grant_type: "authorization_code" });
      if (!t.refresh_token) throw new GoogleAuthError("Google did not return offline access. Please try connecting again.");
      // The ID token comes straight from Google's token endpoint over TLS, so its claims can be read directly.
      const claims = t.id_token ? decodeJwtPayload(t.id_token) : {};
      const email = String(claims.email ?? "");
      if (!email) throw new GoogleAuthError("Google did not share the account email. Please try again.");
      const scopes = t.scope ?? "";
      if (!scopes.includes("drive.file")) throw new GoogleAuthError("Please allow the CRM to open the sheets you pick (the Drive checkbox on Google's screen).");
      return { email, refreshToken: t.refresh_token, scopes };
    },

    async accessToken(refreshToken) {
      const t = await token({ refresh_token: refreshToken, grant_type: "refresh_token" });
      return t.access_token;
    },

    async revoke(refreshToken) {
      await call(`${REVOKE}?token=${encodeURIComponent(refreshToken)}`, { method: "POST" }).catch(() => undefined);
    },

    async spreadsheet(accessToken, spreadsheetId): Promise<SpreadsheetInfo> {
      const fields = "spreadsheetId,properties(title,timeZone),sheets(properties(sheetId,title,gridProperties(rowCount)))";
      const r = await sheetsGet<{
        spreadsheetId: string;
        properties: { title: string; timeZone: string };
        sheets: { properties: { sheetId: number; title: string; gridProperties?: { rowCount?: number } } }[];
      }>(accessToken, `${SHEETS}/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`);
      return {
        id: r.spreadsheetId,
        title: r.properties.title,
        timeZone: r.properties.timeZone || "Africa/Cairo",
        tabs: r.sheets.map((s) => ({ gid: s.properties.sheetId, title: s.properties.title, rows: s.properties.gridProperties?.rowCount ?? 0 })),
      };
    },

    async values(accessToken, spreadsheetId, tabTitle): Promise<Cell[][]> {
      const q = new URLSearchParams({ valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER", majorDimension: "ROWS" });
      const r = await sheetsGet<{ values?: Cell[][] }>(
        accessToken,
        `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(tabRange(tabTitle))}?${q}`,
      );
      return r.values ?? [];
    },
  };
}
