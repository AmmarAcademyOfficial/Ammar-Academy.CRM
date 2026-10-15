/**
 * Centralized business rules.
 *
 * Every screen, the prototype store and (from Phase 2) the server actions call
 * these functions, so a rule changes in exactly one place. Functions here are
 * pure: no React, no database, no clock unless one is passed in.
 */
import type {
  FieldDefinition,
  FieldValue,
  FollowUp,
  ID,
  Inquiry,
  PaymentStatus,
  PaymentSubmission,
  Profile,
  Settings,
  Shift,
  Stage,
  StageKey,
  TimeOff,
} from "./types";

export const CAIRO_TZ = "Africa/Cairo";

// ── Phone numbers ─────────────────────────────────────────────────────────

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EXT_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";

/** Converts Arabic-Indic digits to Latin digits. */
export function latinDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (d) => {
    const i = ARABIC_INDIC.indexOf(d);
    return String(i >= 0 ? i : EXT_ARABIC_INDIC.indexOf(d));
  });
}

/**
 * Normalizes a phone number to an international form.
 * Local Egyptian numbers (01x…) are read as +20. Other numbers keep the
 * country code they were entered with.
 */
export function normalizePhone(raw: string): string {
  let s = latinDigits(raw).trim();
  const hadPlus = s.startsWith("+");
  s = s.replace(/[^\d]/g, "");
  if (!s) return "";
  if (!hadPlus && s.startsWith("00")) return "+" + s.slice(2);
  if (hadPlus) return "+" + s;
  if (/^01\d{9}$/.test(s)) return "+20" + s.slice(1);
  if (/^201\d{9}$/.test(s)) return "+" + s;
  if (/^1\d{9}$/.test(s)) return "+20" + s;
  return s;
}

export function isValidPhone(raw: string): boolean {
  const n = normalizePhone(raw);
  const digits = n.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15;
}

/**
 * Search matching that tolerates spaces, dashes, a missing leading zero,
 * and +20 / 0020 / 0 prefixes.
 */
export function phoneMatches(query: string, normalized: string): boolean {
  const q = latinDigits(query).replace(/\D/g, "");
  if (q.length < 3) return false;
  const target = normalized.replace(/\D/g, "");
  if (target.includes(q)) return true;
  const qn = normalizePhone(query).replace(/\D/g, "");
  if (qn.length >= 3 && target.includes(qn)) return true;
  // "0100…" typed against "+20100…": drop the local leading zero.
  if (q.startsWith("0") && target.includes(q.slice(1))) return true;
  return false;
}

/** Groups +20 100 123 4567 for display. Always rendered left-to-right. */
export function formatPhone(normalized: string): string {
  const m = normalized.match(/^\+20(\d{3})(\d{3})(\d{4})$/);
  if (m) return `+20 ${m[1]} ${m[2]} ${m[3]}`;
  return normalized;
}

export function whatsappUrl(normalized: string): string {
  return `https://wa.me/${normalized.replace(/\D/g, "")}`;
}

export function telUrl(normalized: string): string {
  return `tel:${normalized}`;
}

// ── Cairo time ────────────────────────────────────────────────────────────

const partsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: CAIRO_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface CairoParts {
  date: string; // YYYY-MM-DD
  weekday: number; // 0 = Sunday
  minutes: number; // minutes since Cairo midnight
}

/** Wall-clock parts in Africa/Cairo, daylight saving included. */
export function cairoParts(at: Date): CairoParts {
  const p = Object.fromEntries(partsFormatter.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: WEEKDAYS.indexOf(p.weekday),
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function isOvernight(shift: Pick<Shift, "start" | "end">): boolean {
  return hhmmToMinutes(shift.end) <= hhmmToMinutes(shift.start);
}

/**
 * True when the shift covers `at`. An overnight shift (end ≤ start) that
 * starts on Monday 22:00 covers Monday 22:00–24:00 and Tuesday 00:00–end.
 */
export function shiftCovers(shift: Shift, at: Date): boolean {
  const { weekday, minutes } = cairoParts(at);
  const start = hhmmToMinutes(shift.start);
  const end = hhmmToMinutes(shift.end);
  if (!isOvernight(shift)) {
    return weekday === shift.weekday && minutes >= start && minutes < end;
  }
  const nextDay = (shift.weekday + 1) % 7;
  return (weekday === shift.weekday && minutes >= start) || (weekday === nextDay && minutes < end);
}

export function onLeave(userId: ID, timeOff: TimeOff[], at: Date): boolean {
  const { date } = cairoParts(at);
  return timeOff.some((t) => t.userId === userId && t.startsOn <= date && date <= t.endsOn);
}

// ── Distribution ──────────────────────────────────────────────────────────

export type IneligibleReason =
  | "inactive"
  | "not_sales"
  | "paused"
  | "on_leave"
  | "off_shift"
  | "program_not_on_shift"
  | "at_capacity";

export interface EligibilityInput {
  programId: ID;
  at: Date;
  profiles: Profile[];
  shifts: Shift[];
  timeOff: TimeOff[];
  openLeadCounts: Record<ID, number>;
  settings: Pick<Settings, "perAgentLeadCapEnabled">;
}

/** Why an agent cannot receive a lead right now, or null when eligible. */
export function ineligibleReason(agent: Profile, input: EligibilityInput): IneligibleReason | null {
  if (agent.role !== "sales") return "not_sales";
  if (!agent.active) return "inactive";
  if (onLeave(agent.id, input.timeOff, input.at)) return "on_leave";
  const covering = input.shifts.filter((s) => s.userId === agent.id && shiftCovers(s, input.at));
  if (covering.length === 0) return "off_shift";
  // Overlapping shifts of the same agent count once: we only ask "any shift covers this program".
  if (!covering.some((s) => s.programIds.includes(input.programId))) return "program_not_on_shift";
  if (agent.paused) return "paused";
  if (
    input.settings.perAgentLeadCapEnabled &&
    agent.maxOpenLeads !== null &&
    (input.openLeadCounts[agent.id] ?? 0) >= agent.maxOpenLeads
  ) {
    return "at_capacity";
  }
  return null;
}

export function eligibleAgents(input: EligibilityInput): Profile[] {
  return input.profiles
    .filter((p) => ineligibleReason(p, input) === null)
    .sort((a, b) => a.rotationOrder - b.rotationOrder);
}

/**
 * Round-robin pick: the first eligible agent after the last one assigned in
 * this program (by fixed rotation order), wrapping around. Ineligible agents
 * are skipped but keep their place in the order.
 */
export function pickNextAgent(
  eligible: Profile[],
  lastAssigned: Profile | undefined,
): Profile | null {
  if (eligible.length === 0) return null;
  const sorted = [...eligible].sort((a, b) => a.rotationOrder - b.rotationOrder);
  if (!lastAssigned) return sorted[0];
  return sorted.find((a) => a.rotationOrder > lastAssigned.rotationOrder) ?? sorted[0];
}

export const INELIGIBLE_LABEL: Record<IneligibleReason, string> = {
  inactive: "Account inactive",
  not_sales: "Not a sales agent",
  paused: "Paused",
  on_leave: "On leave",
  off_shift: "Off shift",
  program_not_on_shift: "Program not on current shift",
  at_capacity: "At lead cap",
};

// ── Stages and next action ────────────────────────────────────────────────

export function stageByKey(stages: Stage[], key: StageKey): Stage {
  const s = stages.find((x) => x.systemKey === key);
  if (!s) throw new Error(`Missing stage ${key}`);
  return s;
}

export function isOpenInquiry(inquiry: Inquiry, stages: Stage[]): boolean {
  const stage = stages.find((s) => s.id === inquiry.stageId);
  return !!stage && !stage.isClosed;
}

export type FollowUpTiming = "overdue" | "today" | "upcoming";

export function followUpTiming(f: Pick<FollowUp, "dueAt">, now: Date): FollowUpTiming {
  const due = new Date(f.dueAt);
  if (due.getTime() < now.getTime()) return "overdue";
  return cairoParts(due).date === cairoParts(now).date ? "today" : "upcoming";
}

export function nextOpenFollowUp(inquiryId: ID, followUps: FollowUp[]): FollowUp | undefined {
  return followUps
    .filter((f) => f.inquiryId === inquiryId && f.status === "open" && !f.onboardingId)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
}

/** An open inquiry needs a future follow-up or a recorded "no follow-up" reason. */
export function needsNextAction(
  inquiry: Inquiry,
  stages: Stage[],
  followUps: FollowUp[],
): boolean {
  if (!isOpenInquiry(inquiry, stages)) return false;
  if (inquiry.noFollowUpReason) return false;
  return !nextOpenFollowUp(inquiry.id, followUps);
}

// ── Payments and handover ─────────────────────────────────────────────────

export interface PaymentTotals {
  paid: number;
  balance: number;
  status: PaymentStatus;
  pending: number;
}

/** Only confirmed submissions count. Pending, rejected and reversed never do. */
export function paymentTotals(agreedTotal: number, submissions: PaymentSubmission[]): PaymentTotals {
  const paid = submissions.filter((s) => s.status === "confirmed").reduce((t, s) => t + s.amount, 0);
  const pending = submissions.filter((s) => s.status === "pending").reduce((t, s) => t + s.amount, 0);
  const status: PaymentStatus = paid <= 0 ? "unpaid" : paid >= agreedTotal ? "fully_paid" : "partially_paid";
  return { paid, balance: Math.max(agreedTotal - paid, 0), status, pending };
}

export type HandoverCheck =
  | { met: true; reason: "full_payment" | "qualifying_deposit" }
  | { met: false; reason: "below_threshold" | "deposit_rule_not_set" | "needs_full_payment" };

export function handoverCheck(
  settings: Pick<Settings, "handoverTrigger" | "depositRule">,
  programId: ID,
  totals: Pick<PaymentTotals, "paid">,
  agreedTotal: number,
): HandoverCheck {
  if (agreedTotal > 0 && totals.paid >= agreedTotal) return { met: true, reason: "full_payment" };
  if (settings.handoverTrigger === "full_payment") return { met: false, reason: "needs_full_payment" };
  const rule = settings.depositRule[programId];
  if (!rule) return { met: false, reason: "deposit_rule_not_set" };
  const threshold = rule.kind === "amount" ? rule.value : (agreedTotal * rule.value) / 100;
  return totals.paid >= threshold && totals.paid > 0
    ? { met: true, reason: "qualifying_deposit" }
    : { met: false, reason: "below_threshold" };
}

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  unpaid: "Unpaid",
  partially_paid: "Partially Paid",
  fully_paid: "Fully Paid",
};

// ── Custom fields ─────────────────────────────────────────────────────────

export function fieldAppliesTo(field: FieldDefinition, programId: ID): boolean {
  return !field.archived && (field.programIds.length === 0 || field.programIds.includes(programId));
}

/**
 * Whether a field is required for an inquiry at a given stage.
 * Lost and Invalid never require extra fields, so closing a lead is never blocked.
 */
export function isFieldRequired(
  field: FieldDefinition,
  programId: ID,
  stageKey: StageKey,
  stages: Stage[],
): boolean {
  if (!fieldAppliesTo(field, programId)) return false;
  if (field.requiredFrom === "never") return false;
  if (field.requiredFrom === "always") return true;
  if (stageKey === "lost" || stageKey === "invalid") return false;
  const from = stages.find((s) => s.systemKey === field.requiredFrom);
  const at = stages.find((s) => s.systemKey === stageKey);
  return !!from && !!at && at.order >= from.order;
}

export function isEmptyValue(v: FieldValue | undefined): boolean {
  return v === null || v === undefined || v === "" || v === false;
}

/**
 * Required fields still missing before moving to `targetStage`.
 * Called only on create and on stage change, so adding a new required field
 * never blocks unrelated edits (a note, a tag) on older records.
 */
export function missingRequiredFields(
  fields: FieldDefinition[],
  inquiry: Pick<Inquiry, "programId" | "customFields">,
  targetStage: StageKey,
  stages: Stage[],
): FieldDefinition[] {
  return fields.filter(
    (f) =>
      !f.core &&
      isFieldRequired(f, inquiry.programId, targetStage, stages) &&
      isEmptyValue(inquiry.customFields[f.id]),
  );
}

/** Checks existing values before a field type change. Returns IDs of values that would not convert. */
export function incompatibleValues(
  values: FieldValue[],
  toType: FieldDefinition["type"],
): number {
  const ok = (v: FieldValue) => {
    if (isEmptyValue(v)) return true;
    switch (toType) {
      case "text":
        return true;
      case "number":
        return !Number.isNaN(Number(v));
      case "date":
        return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
      case "checkbox":
        return typeof v === "boolean";
      case "phone":
        return typeof v === "string" && isValidPhone(v);
      case "dropdown":
        return typeof v === "string";
    }
  };
  return values.filter((v) => !ok(v)).length;
}

// ── Display ───────────────────────────────────────────────────────────────

export function formatCairo(ts: string | Date, style: "datetime" | "date" | "time" = "datetime"): string {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  const opts: Intl.DateTimeFormatOptions =
    style === "date"
      ? { day: "numeric", month: "short", year: "numeric" }
      : style === "time"
        ? { hour: "numeric", minute: "2-digit" }
        : { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" };
  return new Intl.DateTimeFormat("en-GB", { timeZone: CAIRO_TZ, ...opts }).format(d);
}

export function formatRelative(ts: string, now: Date): string {
  const diffMin = Math.round((new Date(ts).getTime() - now.getTime()) / 60000);
  const abs = Math.abs(diffMin);
  const unit =
    abs < 60 ? `${abs} min` : abs < 60 * 24 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`;
  if (abs < 1) return "now";
  return diffMin < 0 ? `${unit} ago` : `in ${unit}`;
}

export function formatMoney(amount: number, currency = "EGP"): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(amount)} ${currency}`;
}
