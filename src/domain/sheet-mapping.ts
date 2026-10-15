/**
 * Automatic matching of Google Sheet column headers to CRM fields.
 *
 * Works for English and Arabic headers as Google Forms, Facebook lead
 * exports and hand-made sheets write them ("Full name", "رقم الهاتف",
 * "Timestamp", "طابع زمني", "phone_number"…). An exact match is "sure";
 * a header that merely contains a known phrase is a "guess" the manager
 * confirms. Pure functions: no Google, no database.
 */
import type { FieldDefinition } from "./types";

export type SystemTarget =
  | "name"
  | "phone"
  | "phone_secondary"
  | "program"
  | "student_name"
  | "contact_type"
  | "submitted_at"
  | "lead_id"
  | "note";

/** A CRM destination for a column: a system target, `field:<field id>`, or "" (ignored). */
export type MappingTarget = SystemTarget | `field:${string}` | "";

export interface ColumnMapping {
  column: number;
  header: string;
  target: MappingTarget;
}

export interface SuggestedColumn extends ColumnMapping {
  confidence: "sure" | "guess" | "none";
}

export type RowIdentity = "lead_id" | "timestamp_phone" | "phone_program";

export const SYSTEM_TARGET_LABEL: Record<SystemTarget, string> = {
  name: "Name",
  phone: "Main phone",
  phone_secondary: "Additional phone",
  program: "Program",
  student_name: "Student name (parent forms)",
  contact_type: "Student or parent",
  submitted_at: "Submission time",
  lead_id: "Lead ID",
  note: "Add to timeline as a note",
};

/** Lowercase, no punctuation, Arabic letter variants unified, tashkeel removed. */
export function normalizeHeader(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[ً-ٰٟـ]/g, "") // tashkeel, tatweel
    .replace(/[̀-ͯ]/g, "") // Latin accents
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[_\-–—/\\|.,:;!?؟،؛()[\]{}*"'`#@+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Phrases are written already normalized (see normalizeHeader).
const SYNONYMS: Record<SystemTarget, string[]> = {
  name: [
    "name", "full name", "fullname", "your name", "your full name", "customer name", "client name", "lead name",
    "first and last name", "الاسم", "اسم", "الاسم بالكامل", "الاسم كامل", "الاسم الكامل", "اسمك", "اسم العميل", "الاسم ثلاثي", "الاسم الثلاثي",
  ],
  phone: [
    "phone", "phone number", "mobile", "mobile number", "mobile no", "phone no", "whatsapp", "whatsapp number", "contact number",
    "telephone", "tel", "cell", "cell phone", "number", "your phone", "your phone number", "your whatsapp number",
    "رقم الهاتف", "الهاتف", "رقم الموبايل", "الموبايل", "موبايل", "رقم التليفون", "التليفون", "تليفون", "رقم الواتساب", "رقم الواتس",
    "واتساب", "واتس اب", "رقم التواصل", "رقم الجوال", "الجوال", "رقم", "رقم موبايل",
  ],
  phone_secondary: [
    "parent phone", "parent phone number", "parents phone", "guardian phone", "second phone", "secondary phone", "alternative phone",
    "alternate phone", "other phone", "another phone", "phone 2", "mobile 2", "father phone", "mother phone",
    "رقم ولي الامر", "رقم هاتف ولي الامر", "رقم اخر", "رقم بديل", "رقم الاب", "رقم الام", "موبايل ولي الامر",
  ],
  program: [
    "program", "programme", "course", "which course", "course name", "exam", "test", "which exam", "which test", "interested in",
    "البرنامج", "الكورس", "كورس", "الدوره", "الامتحان", "نوع الامتحان", "مهتم ب",
  ],
  student_name: ["student name", "student s name", "name of student", "child name", "son daughter name", "اسم الطالب", "اسم الطالبه", "اسم الابن"],
  contact_type: [
    "who is filling", "who is filling this form", "are you a student or parent", "student or parent", "you are", "i am", "relation",
    "انت", "صفتك", "طالب ام ولي امر", "طالب او ولي امر",
  ],
  submitted_at: [
    "timestamp", "time stamp", "submitted at", "submission time", "submission date", "submitted", "created time", "created at",
    "date", "date time", "طابع زمني", "الطابع الزمني", "التاريخ", "وقت التسجيل", "تاريخ التسجيل",
  ],
  lead_id: ["id", "lead id", "leadgen id", "submission id", "response id", "رقم الطلب", "كود"],
  note: [
    "message", "comments", "comment", "notes", "note", "questions", "any questions", "your message", "details", "inquiry",
    "how did you hear about us", "ملاحظات", "رساله", "استفسار", "استفسارك", "سؤالك", "تفاصيل",
  ],
};

// Extra phrases for the starter custom fields, by field key.
const FIELD_SYNONYMS: Record<string, string[]> = {
  grade: ["grade", "class", "school year", "year", "current grade", "الصف", "الصف الدراسي", "السنه الدراسيه", "سنه دراسيه"],
  school: ["school", "school name", "your school", "المدرسه", "اسم المدرسه"],
  target_score: ["target score", "target", "desired score", "score goal", "الدرجه المستهدفه", "السكور المستهدف", "المجموع المستهدف"],
  exam_date: ["exam date", "test date", "expected exam date", "when is your exam", "تاريخ الامتحان", "موعد الامتحان", "ميعاد الامتحان"],
  ielts_type: ["ielts type", "academic or general", "ielts module", "module", "نوع الايلتس", "اكاديمي ام جنرال"],
};

interface Candidate {
  column: number;
  target: Exclude<MappingTarget, "">;
  score: number; // 3 exact, 2 contains
  specificity: number;
}

function phraseScore(header: string, phrase: string): { score: number; specificity: number } | null {
  if (!header || !phrase) return null;
  if (header === phrase) return { score: 3, specificity: phrase.length };
  // Whole-word containment, only for phrases long enough to mean something.
  if (phrase.length >= 4 && ` ${header} `.includes(` ${phrase} `)) return { score: 2, specificity: phrase.length };
  return null;
}

/**
 * Suggests a target for every column. Each target is used once (several
 * columns may become notes), the strongest and most specific match wins.
 */
export function suggestMapping(headers: string[], fields: Pick<FieldDefinition, "id" | "key" | "label" | "archived">[]): SuggestedColumn[] {
  const candidates: Candidate[] = [];
  headers.forEach((raw, column) => {
    const h = normalizeHeader(raw);
    if (!h) return;
    for (const [target, phrases] of Object.entries(SYNONYMS) as [SystemTarget, string[]][]) {
      for (const phrase of phrases) {
        const m = phraseScore(h, phrase);
        if (m) candidates.push({ column, target, ...m });
      }
    }
    for (const f of fields) {
      if (f.archived) continue;
      const phrases = [normalizeHeader(f.label), normalizeHeader(f.key.replace(/_/g, " ")), ...(FIELD_SYNONYMS[f.key] ?? [])];
      for (const phrase of phrases) {
        const m = phraseScore(h, phrase);
        // Custom fields win ties against generic system phrases of the same length.
        if (m) candidates.push({ column, target: `field:${f.id}`, score: m.score, specificity: m.specificity + 0.5 });
      }
    }
  });

  // Within one column the strongest, most specific phrase decides what the column means.
  // Between columns competing for one target: exact beats contains; among exact matches the
  // leftmost column wins (forms put the main question first); among guesses the most specific.
  candidates.sort((a, b) =>
    b.score - a.score ||
    (a.column === b.column || a.score === 2 ? b.specificity - a.specificity : 0) ||
    a.column - b.column ||
    b.specificity - a.specificity);
  const byColumn = new Map<number, Candidate>();
  const usedTargets = new Set<string>();
  for (const c of candidates) {
    if (byColumn.has(c.column)) continue;
    if (c.target !== "note" && usedTargets.has(c.target)) continue;
    byColumn.set(c.column, c);
    usedTargets.add(c.target);
  }

  let result: SuggestedColumn[] = headers.map((header, column) => {
    const c = byColumn.get(column);
    return c
      ? { column, header, target: c.target, confidence: c.score === 3 ? "sure" : "guess" }
      : { column, header, target: "", confidence: "none" };
  });

  // A form with only "Student name" (no separate name column): that column is the contact's name.
  if (!result.some((r) => r.target === "name")) {
    result = result.map((r) => (r.target === "student_name" ? { ...r, target: "name", confidence: "guess" } : r));
  }
  return result;
}

export function suggestIdentity(mapping: Pick<ColumnMapping, "target">[]): RowIdentity {
  if (mapping.some((m) => m.target === "lead_id")) return "lead_id";
  if (mapping.some((m) => m.target === "submitted_at")) return "timestamp_phone";
  return "phone_program";
}

/** Problems that block saving a mapping, in plain English. */
export function mappingProblems(mapping: Pick<ColumnMapping, "target">[], identity: RowIdentity): string[] {
  const targets = mapping.map((m) => m.target).filter(Boolean);
  const problems: string[] = [];
  if (!targets.includes("name")) problems.push("Choose the column that holds the name.");
  if (!targets.includes("phone")) problems.push("Choose the column that holds the phone number.");
  const dupes = targets.filter((t, i) => t !== "note" && targets.indexOf(t) !== i);
  if (dupes.length) problems.push("Each CRM field can be matched to one column only.");
  if (identity === "lead_id" && !targets.includes("lead_id")) problems.push("Choose the lead ID column, or identify rows another way.");
  if (identity === "timestamp_phone" && !targets.includes("submitted_at")) problems.push("Choose the timestamp column, or identify rows another way.");
  return problems;
}

/** First row (of the first five) that looks like a header: at least two filled cells, mostly text. */
export function detectHeaderRow(rows: unknown[][]): number {
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const cells = rows[i].filter((c) => c !== null && c !== undefined && String(c).trim() !== "");
    const text = cells.filter((c) => typeof c === "string" && !/^\+?[\d\s-]+$/.test(c));
    if (cells.length >= 2 && text.length >= cells.length * 0.6) return i + 1;
  }
  return 1;
}
