import { describe, expect, it } from "vitest";
import { detectHeaderRow, mappingProblems, normalizeHeader, suggestIdentity, suggestMapping } from "./sheet-mapping";
import { matchProgram, parseRow, serialToIso, type RowContext } from "./sheet-rows";

const FIELDS = [
  { id: "f-grade", key: "grade", label: "Grade", archived: false },
  { id: "f-school", key: "school", label: "School", archived: false },
  { id: "f-target", key: "target_score", label: "Target score", archived: false },
  { id: "f-exam", key: "exam_date", label: "Exam date", archived: false },
];
const targetOf = (headers: string[], h: string) => suggestMapping(headers, FIELDS).find((m) => m.header === h);

describe("header matching", () => {
  it("normalizes Arabic letter variants and punctuation", () => {
    expect(normalizeHeader("  رقم الهاتف (واتساب)؟ ")).toBe("رقم الهاتف واتساب");
    expect(normalizeHeader("الصفّ الدراسيّ")).toBe("الصف الدراسي");
    expect(normalizeHeader("Phone_Number")).toBe("phone number");
  });

  it("maps a typical English Google Form", () => {
    const headers = ["Timestamp", "Full name", "Phone number (WhatsApp)", "Grade", "School name", "Target score", "Any questions?"];
    const m = suggestMapping(headers, FIELDS);
    expect(m.map((x) => x.target)).toEqual(["submitted_at", "name", "phone", "field:f-grade", "field:f-school", "field:f-target", "note"]);
    expect(m[0].confidence).toBe("sure");
    expect(m[2].confidence).toBe("guess"); // "phone number whatsapp" contains "phone number"
  });

  it("maps a typical Arabic Google Form", () => {
    const headers = ["طابع زمني", "الاسم بالكامل", "رقم الموبايل", "رقم ولي الأمر", "الصف الدراسي", "المدرسة", "تاريخ الامتحان", "ملاحظات"];
    expect(suggestMapping(headers, FIELDS).map((x) => x.target)).toEqual([
      "submitted_at", "name", "phone", "phone_secondary", "field:f-grade", "field:f-school", "field:f-exam", "note",
    ]);
  });

  it("maps a Facebook lead export", () => {
    const headers = ["id", "created_time", "ad_name", "full_name", "phone_number", "which_course"];
    expect(suggestMapping(headers, FIELDS).map((x) => x.target)).toEqual(["lead_id", "submitted_at", "", "name", "phone", "program"]);
  });

  it("parent forms: parent name is the contact, student name is kept separately", () => {
    const headers = ["Parent name", "Student name", "Mobile"];
    expect(targetOf(headers, "Parent name")?.target).toBe("name");
    expect(targetOf(headers, "Student name")?.target).toBe("student_name");
    // With no other name column, "Student name" becomes the name.
    expect(targetOf(["Student name", "Mobile"], "Student name")?.target).toBe("name");
  });

  it("each target once (except notes); a specific field beats a generic word", () => {
    const m = suggestMapping(["Phone", "Mobile", "Exam date", "Message", "Comments"], FIELDS);
    expect(m.map((x) => x.target)).toEqual(["phone", "", "field:f-exam", "note", "note"]);
  });

  it("chooses row identity and reports what is missing", () => {
    expect(suggestIdentity([{ target: "lead_id" }, { target: "submitted_at" }])).toBe("lead_id");
    expect(suggestIdentity([{ target: "submitted_at" }])).toBe("timestamp_phone");
    expect(suggestIdentity([{ target: "name" }])).toBe("phone_program");
    expect(mappingProblems([{ target: "name" }], "phone_program")).toEqual(["Choose the column that holds the phone number."]);
    expect(mappingProblems([{ target: "name" }, { target: "phone" }, { target: "phone" }], "phone_program")).toContain("Each CRM field can be matched to one column only.");
  });

  it("finds the header row below a title row", () => {
    expect(detectHeaderRow([["SAT leads — October"], ["Timestamp", "Name", "Phone"], [46000.5, "Ali", "01001234567"]])).toBe(2);
    expect(detectHeaderRow([["Name", "Phone"], ["Ali", "0100"]])).toBe(1);
  });
});

const ctx: RowContext = {
  programs: [
    { id: "p-sat", code: "SAT", name: "SAT", active: true },
    { id: "p-ielts", code: "IELTS", name: "IELTS", active: true },
  ],
  defaultProgramId: "p-sat",
  fields: [
    { id: "f-grade", label: "Grade", type: "dropdown", archived: false, programIds: [], options: [{ id: "o-11", label: "Grade 11" }, { id: "o-12", label: "Grade 12" }] },
    { id: "f-exam", label: "Exam date", type: "date", archived: false, programIds: [] },
    { id: "f-target", label: "Target score", type: "number", archived: false, programIds: ["p-sat"] },
  ],
  timeZone: "Africa/Cairo",
  identity: "timestamp_phone",
};
const MAP = [
  { column: 0, header: "Timestamp", target: "submitted_at" as const },
  { column: 1, header: "Name", target: "name" as const },
  { column: 2, header: "Phone", target: "phone" as const },
  { column: 3, header: "Course", target: "program" as const },
  { column: 4, header: "Grade", target: "field:f-grade" as const },
  { column: 5, header: "Exam date", target: "field:f-exam" as const },
  { column: 6, header: "Target", target: "field:f-target" as const },
  { column: 7, header: "Message", target: "note" as const },
];

describe("row parsing", () => {
  it("converts spreadsheet serial times in the sheet's time zone", () => {
    // 46309.5 = 2026-10-14 12:00 wall time. Cairo is UTC+3 in October 2026.
    expect(serialToIso(46309.5, "Africa/Cairo")).toBe("2026-10-14T09:00:00.000Z");
    expect(serialToIso(46037.5, "Africa/Cairo")).toBe("2026-01-15T10:00:00.000Z"); // winter, UTC+2
  });

  it("builds a full payload", async () => {
    const r = await parseRow([46309.5, "  Mona   Adel ", 1001234567, "Digital SAT", "grade 12", 46400, "1450", "Prefers evenings"], MAP, ctx);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.payload).toMatchObject({
      name: "Mona Adel",
      phone_normalized: "+201001234567", // Sheets dropped the leading zero
      program_id: "p-sat",
      submitted_at: "2026-10-14T09:00:00.000Z",
      custom: { "f-grade": "o-12", "f-exam": "2027-01-13", "f-target": 1450 },
      extra_note: "Message: Prefers evenings",
      contact_type: "student",
    });
    expect(r.raw.Timestamp).toBe("14 Oct 2026, 12:00");
    expect(r.key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("reads Arabic digits and program names", async () => {
    const r = await parseRow([null, "يوسف", "٠١٠٠١٢٣٤٥٦٧", "ايلتس اكاديمي"], MAP, ctx);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.payload.phone_normalized).toBe("+201001234567");
      expect(r.payload.program_id).toBe("p-ielts");
      expect(r.payload.custom["f-target"]).toBeUndefined(); // SAT-only field skipped for IELTS
    }
  });

  it("sends bad rows to review with plain reasons", async () => {
    const r = await parseRow([46309.5, "", "12345", "Math"], MAP, ctx);
    expect(r.kind).toBe("review");
    if (r.kind === "review") {
      expect(r.problems).toEqual(["Name is missing", 'Phone number is not valid: "12345"', 'Program "Math" is not one of the CRM programs']);
      expect(r.raw.Phone).toBe("12345");
    }
    const r2 = await parseRow([46309.5, "Ali", "", ""], MAP, ctx);
    expect(r2.kind === "review" && r2.problems).toEqual(["Phone number is missing"]);
    const r3 = await parseRow([46309.5, "Ali", "0100123", ""], MAP, ctx);
    expect(r3.kind === "review" && r3.problems[0]).toMatch(/Phone number is not valid|Egyptian/);
  });

  it("skips blank rows and keeps identity stable", async () => {
    expect((await parseRow([null, "", "", ""], MAP, ctx)).kind).toBe("blank");
    const a = await parseRow([46309.5, "Ali", "01001234567"], MAP, ctx);
    const b = await parseRow([46309.5, "Ali Hassan", "01001234567"], MAP, ctx); // name edited later
    const c = await parseRow([46309.6, "Ali", "01001234567"], MAP, ctx); // a second submission
    expect(a.kind === "ok" && b.kind === "ok" && a.key === b.key).toBe(true);
    expect(a.kind === "ok" && c.kind === "ok" && a.key !== c.key).toBe(true);
  });

  it("unknown dropdown text is passed through for the database to note", async () => {
    const r = await parseRow([46309.5, "Ali", "01001234567", "", "Grade 9"], MAP, ctx);
    expect(r.kind === "ok" && r.payload.custom["f-grade"]).toBe("Grade 9");
  });

  it("matches programs carefully", () => {
    expect(matchProgram("SAT", ctx.programs)).toBe("p-sat");
    expect(matchProgram("سات", ctx.programs)).toBe("p-sat");
    expect(matchProgram("SAT and IELTS", ctx.programs)).toBe("ambiguous");
    expect(matchProgram("Saturday", ctx.programs)).toBeNull();
  });
});
