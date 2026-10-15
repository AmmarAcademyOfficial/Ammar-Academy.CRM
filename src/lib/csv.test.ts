import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv";

describe("CSV export", () => {
  it("quotes values and doubles inner quotes", () => {
    expect(csvCell('Ali "the student"')).toBe('"Ali ""the student"""');
    expect(csvCell(12)).toBe('"12"');
    expect(csvCell(null)).toBe('""');
  });
  it("neutralises anything a spreadsheet would run as a formula", () => {
    for (const v of ["=HYPERLINK(\"http://x\")", "+20100", "-5+3", "@SUM(A1)", "\t=1"]) expect(csvCell(v).startsWith(`"'`)).toBe(true);
  });
  it("keeps Arabic text and starts with a byte-order mark", () => {
    const csv = toCsv([["الاسم", "مريم خالد"]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('"الاسم","مريم خالد"');
  });
});
