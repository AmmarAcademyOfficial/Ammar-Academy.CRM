import type { Cell } from "@/domain/sheet-rows";

/** The only Google permissions the CRM asks for. drive.file = files the manager picks, nothing else. */
export const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/drive.file"];

export interface SpreadsheetInfo {
  id: string;
  title: string;
  timeZone: string;
  tabs: { gid: number; title: string; rows: number }[];
}

export interface GrantedSignIn {
  email: string;
  refreshToken: string;
  scopes: string;
}

export interface GoogleApi {
  /** Where to send the manager to sign in. */
  authUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<GrantedSignIn>;
  accessToken(refreshToken: string): Promise<string>;
  revoke(refreshToken: string): Promise<void>;
  spreadsheet(accessToken: string, spreadsheetId: string): Promise<SpreadsheetInfo>;
  /** All rows of one tab, unformatted (numbers as numbers, dates as serials). */
  values(accessToken: string, spreadsheetId: string, tabTitle: string): Promise<Cell[][]>;
}

/** The stored sign-in no longer works: the manager must reconnect. */
export class GoogleAuthError extends Error {
  constructor(message = "Google sign-in expired or was revoked. Reconnect the Google account.") {
    super(message);
  }
}

/** The spreadsheet or tab is gone, or the CRM can no longer open it. */
export class GoogleNotFoundError extends Error {}

/** Google was slow or unavailable; try again on the next run. */
export class GoogleTransientError extends Error {}
