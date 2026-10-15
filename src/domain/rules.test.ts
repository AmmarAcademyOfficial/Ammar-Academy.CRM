import { describe, expect, it } from "vitest";
import {
  eligibleAgents,
  handoverCheck,
  ineligibleReason,
  isFieldRequired,
  missingRequiredFields,
  normalizePhone,
  paymentTotals,
  phoneMatches,
  pickNextAgent,
  shiftCovers,
} from "./rules";
import type { FieldDefinition, PaymentSubmission, Profile, Shift, Stage } from "./types";

const agent = (id: string, order: number, extra: Partial<Profile> = {}): Profile => ({
  id,
  fullName: id,
  email: `${id}@example.test`,
  role: "sales",
  active: true,
  rotationOrder: order,
  paused: false,
  maxOpenLeads: null,
  ...extra,
});

describe("phone numbers", () => {
  it("normalizes Egyptian local, spaced, 0020 and Arabic-Indic formats to +20", () => {
    expect(normalizePhone("0100 123 4567")).toBe("+201001234567");
    expect(normalizePhone("+20 100-123-4567")).toBe("+201001234567");
    expect(normalizePhone("00201001234567")).toBe("+201001234567");
    expect(normalizePhone("٠١٠٠١٢٣٤٥٦٧")).toBe("+201001234567");
    expect(normalizePhone("1001234567")).toBe("+201001234567");
  });
  it("keeps other country codes", () => {
    expect(normalizePhone("+971 50 123 4567")).toBe("+971501234567");
  });
  it("matches searches across formats", () => {
    expect(phoneMatches("0100 123", "+201001234567")).toBe(true);
    expect(phoneMatches("+20 100 1234567", "+201001234567")).toBe(true);
    expect(phoneMatches("4567", "+201001234567")).toBe(true);
    expect(phoneMatches("0111", "+201001234567")).toBe(false);
  });
});

describe("shifts in Africa/Cairo", () => {
  const overnight: Shift = { id: "s", userId: "a", weekday: 1, start: "22:00", end: "06:00", programIds: ["sat"] };

  it("covers Monday night and the following Tuesday morning (summer time, UTC+3)", () => {
    expect(shiftCovers(overnight, new Date("2026-10-12T20:00:00Z"))).toBe(true); // Mon 23:00
    expect(shiftCovers(overnight, new Date("2026-10-13T00:00:00Z"))).toBe(true); // Tue 03:00
    expect(shiftCovers(overnight, new Date("2026-10-13T03:00:00Z"))).toBe(false); // Tue 06:00
    expect(shiftCovers(overnight, new Date("2026-10-11T20:00:00Z"))).toBe(false); // Sun 23:00
  });

  it("follows the daylight-saving offset (winter UTC+2 vs summer UTC+3)", () => {
    // Winter: Mon 5 Jan 2026, 22:00 Cairo = 20:00 UTC
    expect(shiftCovers(overnight, new Date("2026-01-05T19:59:00Z"))).toBe(false);
    expect(shiftCovers(overnight, new Date("2026-01-05T20:00:00Z"))).toBe(true);
    // Summer: Mon 6 Jul 2026, 22:00 Cairo = 19:00 UTC
    expect(shiftCovers(overnight, new Date("2026-07-06T18:59:00Z"))).toBe(false);
    expect(shiftCovers(overnight, new Date("2026-07-06T19:00:00Z"))).toBe(true);
  });
});

describe("round-robin distribution", () => {
  const at = new Date("2026-10-14T08:00:00Z"); // Wed 11:00 Cairo
  const day: Shift[] = ["a", "b", "c"].map((u) => ({
    id: `sh-${u}`,
    userId: u,
    weekday: 3,
    start: "09:00",
    end: "17:00",
    programIds: ["sat"],
  }));
  const base = {
    programId: "sat",
    at,
    shifts: day,
    timeOff: [],
    openLeadCounts: {},
    settings: { perAgentLeadCapEnabled: false },
  };

  it("rotates A, B, C, then A again", () => {
    const profiles = [agent("a", 1), agent("b", 2), agent("c", 3)];
    const eligible = eligibleAgents({ ...base, profiles });
    let last: Profile | undefined;
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      last = pickNextAgent(eligible, last) ?? undefined;
      order.push(last!.id);
    }
    expect(order).toEqual(["a", "b", "c", "a"]);
  });

  it("skips a paused agent without losing the rotation position", () => {
    const profiles = [agent("a", 1), agent("b", 2, { paused: true }), agent("c", 3)];
    const eligible = eligibleAgents({ ...base, profiles });
    expect(pickNextAgent(eligible, profiles[0])?.id).toBe("c");
  });

  it("counts an agent once when their own shifts overlap", () => {
    const profiles = [agent("a", 1)];
    const shifts = [...day, { ...day[0], id: "dup", start: "10:00", end: "12:00" }];
    expect(eligibleAgents({ ...base, profiles, shifts })).toHaveLength(1);
  });

  it("does not assign IELTS to an agent whose shift is SAT-only", () => {
    expect(ineligibleReason(agent("a", 1), { ...base, programId: "ielts", profiles: [] })).toBe(
      "program_not_on_shift",
    );
  });

  it("returns nobody when no one is eligible, so the inquiry is queued", () => {
    const profiles = [agent("a", 1, { active: false })];
    expect(pickNextAgent(eligibleAgents({ ...base, profiles }), undefined)).toBeNull();
  });
});

describe("payments and handover", () => {
  const sub = (amount: number, status: PaymentSubmission["status"]): PaymentSubmission => ({
    id: Math.random().toString(),
    enrollmentId: "e",
    amount,
    paidOn: "2026-10-01",
    reference: "r", method: "instapay", hasReceipt: true,
    submittedById: "a",
    submittedAt: "2026-10-01T10:00:00Z",
    status,
  });

  it("counts confirmed payments only", () => {
    const t = paymentTotals(10000, [sub(3000, "confirmed"), sub(5000, "pending"), sub(2000, "rejected")]);
    expect(t).toMatchObject({ paid: 3000, balance: 7000, status: "partially_paid", pending: 5000 });
  });

  it("does not hand over when the deposit rule is not set", () => {
    const r = handoverCheck({ handoverTrigger: "qualifying_deposit", depositRule: { sat: null } }, "sat", { paid: 5000 }, 10000);
    expect(r).toEqual({ met: false, reason: "deposit_rule_not_set" });
  });

  it("hands over at the configured percentage deposit", () => {
    const settings = { handoverTrigger: "qualifying_deposit" as const, depositRule: { sat: { kind: "percent" as const, value: 30 } } };
    expect(handoverCheck(settings, "sat", { paid: 2999 }, 10000).met).toBe(false);
    expect(handoverCheck(settings, "sat", { paid: 3000 }, 10000).met).toBe(true);
  });

  it("always hands over on full payment", () => {
    const r = handoverCheck({ handoverTrigger: "full_payment", depositRule: {} }, "sat", { paid: 10000 }, 10000);
    expect(r.met).toBe(true);
  });
});

describe("stage-based required fields", () => {
  const stages: Stage[] = ["new", "contacting", "qualified", "awaiting_payment", "enrolled", "lost", "invalid"].map(
    (k, i) => ({ id: k, systemKey: k as Stage["systemKey"], label: k, order: i, isClosed: i >= 4, agentSelectable: true }),
  );
  const school: FieldDefinition = {
    id: "f1",
    key: "school",
    label: "School",
    type: "text",
    importance: "standard",
    requiredFrom: "qualified",
    programIds: [],
    visibleTo: ["manager", "sales"],
    editableBy: ["manager", "sales"],
    options: [],
    order: 1,
    archived: false,
    core: false,
  };

  it("requires the field from Qualified onward, but never for Lost", () => {
    expect(isFieldRequired(school, "sat", "contacting", stages)).toBe(false);
    expect(isFieldRequired(school, "sat", "awaiting_payment", stages)).toBe(true);
    expect(isFieldRequired(school, "sat", "lost", stages)).toBe(false);
  });

  it("ignores archived fields", () => {
    const inquiry = { programId: "sat", customFields: {} };
    expect(missingRequiredFields([{ ...school, archived: true }], inquiry, "qualified", stages)).toHaveLength(0);
    expect(missingRequiredFields([school], inquiry, "qualified", stages)).toHaveLength(1);
  });
});
