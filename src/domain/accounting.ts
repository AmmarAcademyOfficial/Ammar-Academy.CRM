/**
 * Accounting periods and totals. Dates are Cairo calendar days as "YYYY-MM-DD".
 * The Academy month runs from the 26th to the 25th and is named after the month it ends in:
 * "November 2026" = 26 Oct – 25 Nov 2026.
 */
import type { MoneyTotal } from "./dto";

export type Period = "today" | "week" | "month" | "academy" | "last_academy" | "custom";

export const PERIODS: { id: Period; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
  { id: "academy", label: "This Academy month" },
  { id: "last_academy", label: "Last Academy month" },
  { id: "custom", label: "Custom dates" },
];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const shiftDay = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12)).toISOString().slice(0, 10); // m may overflow

/** The Academy month containing `day` (offset -1 = the one before). */
export function academyMonth(day: string, offset = 0): { from: string; to: string; label: string } {
  const [y, m, d] = day.split("-").map(Number);
  // The month it ends in: this month until the 25th, next month from the 26th.
  const endMonth = (d >= 26 ? m + 1 : m) + offset;
  const to = ymd(y, endMonth, 25);
  const from = ymd(y, endMonth - 1, 26);
  const [ty, tm] = to.split("-").map(Number);
  return { from, to, label: `${MONTHS[tm - 1]} ${ty}` };
}

/** The date range of a period. Weeks start on Sunday, as the Academy's shifts do. */
export function periodRange(period: Period, today: string, custom: { from: string; to: string }): { from: string; to: string } {
  switch (period) {
    case "today":
      return { from: today, to: today };
    case "week": {
      const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday
      return { from: shiftDay(today, -dow), to: today };
    }
    case "month":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "academy": {
      const a = academyMonth(today);
      return { from: a.from, to: a.to < today ? a.to : today };
    }
    case "last_academy": {
      const a = academyMonth(today, -1);
      return { from: a.from, to: a.to };
    }
    default:
      return custom;
  }
}

/** Every day from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = shiftDay(d, 1)) out.push(d);
  return out;
}

/** Adds amounts per currency (never across currencies), largest first. */
export function sumByCurrency(items: { amount: number; currency: string }[]): MoneyTotal[] {
  const m = new Map<string, number>();
  for (const i of items) m.set(i.currency, (m.get(i.currency) ?? 0) + i.amount);
  return [...m.entries()].map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 })).sort((a, b) => b.amount - a.amount);
}
