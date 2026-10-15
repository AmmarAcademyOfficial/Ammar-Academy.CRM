import { describe, expect, it, vi } from "vitest";
import { realGoogle, tabRange } from "./real";
import { GoogleAuthError, GoogleNotFoundError, GoogleTransientError } from "./types";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const idToken = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

describe("real Google client (mocked network)", () => {
  it("asks only for openid, email and drive.file, with offline access", () => {
    const url = new URL(realGoogle({ clientId: "cid", clientSecret: "s" }).authUrl("st4te", "https://crm.example/api/google/callback"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("st4te");
  });

  it("exchanges the code and reads the account email", async () => {
    const fetch = vi.fn(async () => json(200, {
      access_token: "at", refresh_token: "rt", scope: "openid https://www.googleapis.com/auth/drive.file email",
      id_token: idToken({ email: "academy@example.test" }),
    }));
    const g = realGoogle({ clientId: "cid", clientSecret: "secret", fetch: fetch as unknown as typeof globalThis.fetch });
    expect(await g.exchangeCode("code123", "https://crm.example/cb")).toEqual({ email: "academy@example.test", refreshToken: "rt", scopes: expect.stringContaining("drive.file") });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_secret")).toBe("secret");
  });

  it("refuses a sign-in where the Drive permission was unticked", async () => {
    const fetch = vi.fn(async () => json(200, { access_token: "at", refresh_token: "rt", scope: "openid email", id_token: idToken({ email: "a@b.c" }) }));
    const g = realGoogle({ clientId: "c", clientSecret: "s", fetch: fetch as unknown as typeof globalThis.fetch });
    await expect(g.exchangeCode("x", "y")).rejects.toThrow(/Drive checkbox/);
  });

  it("a revoked refresh token means reconnect", async () => {
    const g = realGoogle({ clientId: "c", clientSecret: "s", fetch: (async () => json(400, { error: "invalid_grant" })) as unknown as typeof fetch });
    await expect(g.accessToken("old")).rejects.toBeInstanceOf(GoogleAuthError);
  });

  it("reads values unformatted with date serials, by tab title", async () => {
    const fetch = vi.fn(async () => json(200, { values: [["Timestamp", "Name"], [46309.5, "Ali"]] }));
    const g = realGoogle({ clientId: "c", clientSecret: "s", fetch: fetch as unknown as typeof globalThis.fetch });
    expect(await g.values("at", "SHEET_ID_123", "Form Responses 1")).toEqual([["Timestamp", "Name"], [46309.5, "Ali"]]);
    const url = new URL((fetch.mock.calls[0] as unknown as [string])[0]);
    expect(decodeURIComponent(url.pathname)).toBe("/v4/spreadsheets/SHEET_ID_123/values/'Form Responses 1'!A1:ZZ");
    expect(url.searchParams.get("valueRenderOption")).toBe("UNFORMATTED_VALUE");
    expect(url.searchParams.get("dateTimeRenderOption")).toBe("SERIAL_NUMBER");
    expect(((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBe("Bearer at");
    expect(tabRange("Ali's tab")).toBe("'Ali''s tab'!A1:ZZ");
  });

  it("maps Google errors to plain outcomes", async () => {
    const g = (status: number, body: unknown = {}) => realGoogle({ clientId: "c", clientSecret: "s", fetch: (async () => json(status, body)) as unknown as typeof fetch });
    await expect(g(404).spreadsheet("at", "id")).rejects.toBeInstanceOf(GoogleNotFoundError);
    await expect(g(403, { error: { status: "PERMISSION_DENIED" } }).spreadsheet("at", "id")).rejects.toBeInstanceOf(GoogleNotFoundError);
    await expect(g(401).spreadsheet("at", "id")).rejects.toBeInstanceOf(GoogleAuthError);
    await expect(g(429).spreadsheet("at", "id")).rejects.toBeInstanceOf(GoogleTransientError);
    await expect(g(503).values("at", "id", "t")).rejects.toBeInstanceOf(GoogleTransientError);
    const offline = realGoogle({ clientId: "c", clientSecret: "s", fetch: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch });
    await expect(offline.spreadsheet("at", "id")).rejects.toBeInstanceOf(GoogleTransientError);
  });

  it("reads spreadsheet title, time zone and tabs", async () => {
    const g = realGoogle({ clientId: "c", clientSecret: "s", fetch: (async () => json(200, {
      spreadsheetId: "abc", properties: { title: "SAT Leads", timeZone: "Africa/Cairo" },
      sheets: [{ properties: { sheetId: 0, title: "Form Responses 1", gridProperties: { rowCount: 1000 } } }],
    })) as unknown as typeof fetch });
    expect(await g.spreadsheet("at", "abc")).toEqual({ id: "abc", title: "SAT Leads", timeZone: "Africa/Cairo", tabs: [{ gid: 0, title: "Form Responses 1", rows: 1000 }] });
  });
});
