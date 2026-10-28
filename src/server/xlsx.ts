import { deflateRawSync } from "node:zlib";

/**
 * A small Excel (.xlsx) writer for the CRM's downloads: several sheets, a frozen header row with
 * filter arrows, real dates and numbers, and totals rows. No outside library, so nothing new is
 * added to what the server runs.
 *
 * Safety: every text cell is written as plain text (an inline string), so Excel never treats it as
 * a formula. Text that starts like a formula (= + - @, a tab or a return) is also marked "text" with
 * Excel's quote prefix, so it stays text even if someone retypes the cell or saves it as CSV.
 */

export type CellType = "text" | "number" | "money" | "date" | "datetime";
export interface Column { header: string; type: CellType; width?: number }
export type CellValue = string | number | boolean | Date | null | undefined;
/** A totals row: a label in the first column and, for chosen columns, a SUMIFS on the currency column. */
export interface TotalsSpec {
  label: (currency: string) => string;
  currencyColumn: number;
  sumColumns: number[];
  /** Only rows where this column equals this text (for example, confirmed payments). */
  where?: { column: number; equals: string | string[] };
}
export interface Sheet { name: string; columns: Column[]; rows: CellValue[][]; totals?: TotalsSpec }

const CAIRO = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** Excel's day number for a moment, as the wall-clock time in Cairo (Egypt's summer time included). */
export function excelDateTime(d: Date): number {
  const p = Object.fromEntries(CAIRO.formatToParts(d).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return wall / 86_400_000 + 25_569;
}

/** Excel's day number for a calendar date "YYYY-MM-DD" (no time zone involved). */
export function excelDate(day: string): number {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000 + 25_569;
}

// Styles (cellXfs index): 0 default, 1 header, 2 date, 3 date+time, 4 money, 5 text kept as text,
// 6 totals label, 7 totals money, 8 number.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="d mmm yyyy"/><numFmt numFmtId="165" formatCode="d mmm yyyy h:mm AM/PM"/><numFmt numFmtId="166" formatCode="#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EBF5"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF9AA0B8"/></top><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" quotePrefix="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="166" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** Characters XML 1.0 cannot hold are dropped; the rest is escaped. */
function xml(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}

export function columnLetter(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const FORMULA_LIKE = /^[=+\-@\t\r]/;

function textCell(ref: string, v: string, style?: number): string {
  const s = style ?? (FORMULA_LIKE.test(v) ? 5 : 0);
  return `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ""}><is><t xml:space="preserve">${xml(v.slice(0, 32_000))}</t></is></c>`;
}

function cell(ref: string, v: CellValue, type: CellType): string {
  if (v === null || v === undefined || v === "") return "";
  if (type === "date" || type === "datetime") {
    const moment = v instanceof Date ? v : typeof v === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? new Date(v) : null;
    const n = moment ? (type === "date" ? Math.floor(excelDateTime(moment)) : excelDateTime(moment))
      : typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? excelDate(v)
      : null;
    if (n === null) return textCell(ref, String(v));
    return `<c r="${ref}" s="${type === "date" ? 2 : 3}"><v>${Math.round(n * 86_400) / 86_400}</v></c>`;
  }
  if (type === "number" || type === "money") {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (!Number.isFinite(n)) return textCell(ref, String(v));
    return `<c r="${ref}" s="${type === "money" ? 4 : 8}"><v>${n}</v></c>`;
  }
  return textCell(ref, typeof v === "boolean" ? (v ? "Yes" : "No") : v instanceof Date ? v.toISOString() : String(v));
}

function sheetXml(sh: Sheet): string {
  const cols = sh.columns;
  const last = columnLetter(cols.length - 1);
  const out: string[] = [];
  out.push(`<row r="1">${cols.map((c, i) => textCell(`${columnLetter(i)}1`, c.header, 1)).join("")}</row>`);
  sh.rows.forEach((r, ri) => {
    const n = ri + 2;
    out.push(`<row r="${n}">${cols.map((c, i) => cell(`${columnLetter(i)}${n}`, r[i], c.type)).join("")}</row>`);
  });
  const dataEnd = sh.rows.length + 1;
  let lastRow = dataEnd;
  if (sh.totals && sh.rows.length) {
    const t = sh.totals;
    const cur = columnLetter(t.currencyColumn);
    const currencies = [...new Set(sh.rows.map((r) => String(r[t.currencyColumn] ?? "")).filter(Boolean))].sort();
    let n = dataEnd + 1; // one empty row between the data and the totals
    for (const c of currencies) {
      n++;
      const parts = [textCell(`A${n}`, t.label(c), 6)];
      for (const col of t.sumColumns) {
        const L = columnLetter(col);
        const w = t.where;
        const wanted = w ? (Array.isArray(w.equals) ? w.equals : [w.equals]) : [];
        const sum = sh.rows.reduce((a, r) => (String(r[t.currencyColumn]) === c && (!w || wanted.includes(String(r[w.column]))) && Number.isFinite(Number(r[col])) ? a + Number(r[col]) : a), 0);
        const q = (v: string) => `"${xml(v.replace(/"/g, '""'))}"`;
        // Several values: an array constant, summed (SUM(SUMIFS(…, {"a","b"}))).
        const crit = wanted.length > 1 ? `{${wanted.map(q).join(",")}}` : wanted.length ? q(wanted[0]) : "";
        const extra = w ? `,${columnLetter(w.column)}2:${columnLetter(w.column)}${dataEnd},${crit}` : "";
        const f = `SUMIFS(${L}2:${L}${dataEnd},${cur}2:${cur}${dataEnd},${q(c)}${extra})`;
        parts.push(`<c r="${L}${n}" s="7"><f>${wanted.length > 1 ? `SUM(${f})` : f}</f><v>${Math.round(sum * 100) / 100}</v></c>`);
      }
      out.push(`<row r="${n}">${parts.join("")}</row>`);
      lastRow = n;
    }
  }
  const widths = cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? (c.type === "datetime" ? 20 : c.type === "date" ? 13 : c.type === "money" ? 13 : 18)}" customWidth="1"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${last}${lastRow}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${widths}</cols>
<sheetData>${out.join("")}</sheetData>
<autoFilter ref="A1:${last}${Math.max(dataEnd, 1)}"/>
</worksheet>`;
}

/** Sheet names: at most 31 characters, none of : \ / ? * [ ], unique. */
function sheetNames(sheets: Sheet[]): string[] {
  const used = new Set<string>();
  return sheets.map((s) => {
    const base = s.name.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31) || "Sheet";
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)} ${i}`;
    used.add(name.toLowerCase());
    return name;
  });
}

export function buildXlsx(sheets: Sheet[], created = new Date()): Buffer {
  const names = sheetNames(sheets);
  const files: [string, string][] = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`],
    ["docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Ammar Academy CRM</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${created.toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><definedNames>${sheets.map((s, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xml(names[i]).replace(/'/g, "''")}'!$A$1:$${columnLetter(s.columns.length - 1)}$${Math.max(s.rows.length + 1, 1)}</definedName>`).join("")}</definedNames><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", STYLES],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return zip(files.map(([name, text]) => [name, Buffer.from(text, "utf8")]), created);
}

// ── ZIP (the container an .xlsx file is) ─────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(entries: [string, Buffer][], when: Date): Buffer {
  const time = ((when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | Math.floor(when.getUTCSeconds() / 2)) & 0xffff;
  const date = (((when.getUTCFullYear() - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate()) & 0xffff;
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, packed);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const cenSize = central.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}
