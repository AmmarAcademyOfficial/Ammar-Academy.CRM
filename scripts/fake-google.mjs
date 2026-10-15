/**
 * Writes the simulated Google data used by GOOGLE_MODE=fake (local review and
 * browser tests). All people and numbers are fictional. Times are spreadsheet
 * day serials in Cairo time, relative to now, like a live Google Form.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const EPOCH = Date.UTC(1899, 11, 30);

/** Cairo wall-clock serial for "minutes ago". */
export function serialMinutesAgo(minutes) {
  const at = new Date(Date.now() - minutes * 60_000);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(at).map((x) => [x.type, x.value]),
  );
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round(((wall - EPOCH) / 86_400_000) * 1e6) / 1e6;
}

export const FAKE_ACCOUNT = "academy.sheets@example.test";
export const SAT_SHEET_ID = "fakeSATleads000000000001";
export const IELTS_SHEET_ID = "fakeIELTSleads0000000002";

export function fakeGoogleData() {
  const sat = [
    ["Timestamp", "Full name", "Phone number (WhatsApp)", "Are you a student or parent?", "Student name", "Grade", "School name", "Target score", "Any questions?"],
    [serialMinutesAgo(60 * 50), "Karim Mostafa", "01005550201", "Student", "", "Grade 12", "Cairo American College", 1450, "Do you have weekend classes?"],
    [serialMinutesAgo(60 * 30), "Dina Fawzy", 1115550202, "Parent", "Omar", "Grade 11", "BISC", "", ""],
    [serialMinutesAgo(60 * 26), "Hoda Salem", "0102 555 0103", "Parent", "Ali", "Grade 12", "", "", "Following up on the December course"],
    [serialMinutesAgo(60 * 9), "Test entry", "12345", "Student", "", "", "", "", ""],
    [serialMinutesAgo(60 * 5), "Seif Ashraf", "+20 128 555 0204", "Student", "", "Grade 10", "Modern Academy", 1350, ""],
    ["", "", "", "", "", "", "", "", ""],
    [serialMinutesAgo(45), "لينا حسام", "٠١٠٠٥٥٥٠٢٠٥", "طالب", "", "Grade 12", "", 1500, "متى يبدأ الكورس؟"],
  ];
  const ielts = [
    ["طابع زمني", "الاسم بالكامل", "رقم الموبايل", "نوع الايلتس", "ملاحظات"],
    [serialMinutesAgo(60 * 20), "مصطفى عادل", "01205550301", "Academic", "عايز أعرف المواعيد"],
    [serialMinutesAgo(60 * 7), "Salma Nabil", "01095550302", "General Training", ""],
    [serialMinutesAgo(60 * 3), "ريهام فتحي", "", "Academic", "اتصلوا بعد الساعة ٦"],
    [serialMinutesAgo(30), "Nader Samy", "01155550303", "Academic", ""],
  ];
  return {
    accounts: { [FAKE_ACCOUNT]: { revoked: false } },
    spreadsheets: {
      [SAT_SHEET_ID]: { title: "SAT Leads — Website Form", timeZone: "Africa/Cairo", tabs: [{ gid: 0, title: "Form Responses 1", rows: sat }, { gid: 18273, title: "Notes", rows: [["Internal notes"]] }] },
      [IELTS_SHEET_ID]: { title: "IELTS Leads — نموذج التسجيل", timeZone: "Africa/Cairo", tabs: [{ gid: 0, title: "ردود النموذج 1", rows: ielts }] },
    },
  };
}

export function writeFakeGoogle(file) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(fakeGoogleData(), null, 2));
}

/** Test helper: change the simulated data (append a row, revoke access…). */
export function updateFakeGoogle(file, fn) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  fn(data);
  writeFileSync(file, JSON.stringify(data, null, 2));
}

// CLI: node scripts/fake-google.mjs [file]
if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] ?? ".local/fake-google.json";
  writeFakeGoogle(file);
  console.log(`Simulated Google data written to ${file}`);
}
