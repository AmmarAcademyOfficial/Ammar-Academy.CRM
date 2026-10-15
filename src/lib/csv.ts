/**
 * One CSV cell, safe to open in Excel or Google Sheets: always quoted, inner quotes doubled, and a
 * value starting with = + - @ (or a tab/return) gets a leading apostrophe so it can never run as a
 * formula. Names and notes come from web forms, so this matters.
 */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Rows to CSV text with a byte-order mark, so Excel reads Arabic names correctly. */
export function toCsv(rows: unknown[][]): string {
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
