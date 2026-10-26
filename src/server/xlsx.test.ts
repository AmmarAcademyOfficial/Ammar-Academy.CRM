/**
 * The Excel writer (Part C): a valid zip with the parts Excel needs, real dates in Cairo time,
 * numbers as numbers, formula-like text kept as text, frozen header, filter arrows and totals.
 */
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildXlsx, columnLetter, excelDate, excelDateTime } from "./xlsx";

/** Reads the zip's central directory and returns every file as text. */
function unzip(buf: Buffer): Record<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const localNameLen = buf.readUInt16LE(local + 26);
    const data = buf.subarray(local + 30 + localNameLen, local + 30 + localNameLen + size);
    out[name] = inflateRawSync(data).toString("utf8");
    p += 46 + nameLen;
  }
  return out;
}

describe("xlsx", () => {
  const file = buildXlsx([
    {
      name: "Payments",
      columns: [{ header: "Customer", type: "text" }, { header: "Paid on", type: "date" }, { header: "At", type: "datetime" }, { header: "Amount", type: "money" }, { header: "Currency", type: "text" }, { header: "Status", type: "text" }],
      rows: [
        ["سارة ناصر", "2026-10-01", new Date("2026-03-01T10:00:00Z"), 1500.5, "EGP", "Confirmed"],
        ["=HYPERLINK(\"http://x\")", "2026-10-02", new Date("2026-07-01T10:00:00Z"), 200, "USD", "Confirmed"],
        ["Tom & <Jerry>", null, null, "300", "EGP", "Waiting for review"],
      ],
      totals: { label: (c) => `Total confirmed ${c}`, currencyColumn: 4, sumColumns: [3], where: { column: 5, equals: "Confirmed" } },
    },
    { name: "Plan: [due]", columns: [{ header: "Due", type: "date" }], rows: [] },
  ], new Date("2026-10-26T12:00:00Z"));
  const parts = unzip(file);

  it("has the parts Excel needs and safe sheet names", () => {
    expect(Object.keys(parts).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "docProps/core.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]);
    expect(parts["xl/workbook.xml"]).toContain('<sheet name="Payments"');
    expect(parts["xl/workbook.xml"]).toContain('<sheet name="Plan   due"');
  });

  it("writes Arabic text, escapes XML, and keeps formula-like text as text", () => {
    const s = parts["xl/worksheets/sheet1.xml"];
    expect(s).toContain("سارة ناصر");
    expect(s).toContain("Tom &amp; &lt;Jerry&gt;");
    expect(s).toContain('<c r="A3" t="inlineStr" s="5"><is><t xml:space="preserve">=HYPERLINK(&quot;http://x&quot;)</t></is></c>');
    expect(s).not.toMatch(/<c r="A\d+"[^>]*><f>/); // no formula in any data cell
  });

  it("dates are Excel dates in Cairo time (winter +2, summer +3); amounts are numbers", () => {
    const s = parts["xl/worksheets/sheet1.xml"];
    expect(s).toContain(`<c r="B2" s="2"><v>${excelDate("2026-10-01")}</v></c>`);
    expect(excelDate("2026-10-01")).toBe(46296);
    expect(excelDateTime(new Date("2026-03-01T10:00:00Z")) - 46082).toBeCloseTo(12 / 24, 6); // 12:00 Cairo
    expect(excelDateTime(new Date("2026-07-01T10:00:00Z")) - 46204).toBeCloseTo(13 / 24, 6); // 13:00 Cairo (summer time)
    expect(s).toContain('<c r="D2" s="4"><v>1500.5</v></c>');
    expect(s).toContain('<c r="D4" s="4"><v>300</v></c>');
  });

  it("freezes the header, adds filter arrows and per-currency totals with live formulas", () => {
    const s = parts["xl/worksheets/sheet1.xml"];
    expect(s).toContain('state="frozen"');
    expect(s).toContain('<autoFilter ref="A1:F4"/>');
    expect(s).toContain('<c r="D6" s="7"><f>SUMIFS(D2:D4,E2:E4,"EGP",F2:F4,"Confirmed")</f><v>1500.5</v></c>');
    expect(s).toContain('<c r="D7" s="7"><f>SUMIFS(D2:D4,E2:E4,"USD",F2:F4,"Confirmed")</f><v>200</v></c>');
  });

  it("column letters", () => {
    expect([0, 25, 26, 27, 701, 702].map(columnLetter)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });
});
