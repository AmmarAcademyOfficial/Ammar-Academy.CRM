import { formatMoney } from "@/domain/rules";
import type { Course, CourseDelivery, PaymentMethod } from "@/domain/types";
import type { Reference } from "@/domain/dto";

export const DELIVERY_LABEL: Record<CourseDelivery, string> = { online: "Online", in_person: "In person", hybrid: "Hybrid" };

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  bank_transfer: "Bank transfer",
  instapay: "InstaPay",
  mobile_wallet: "Mobile wallet (Vodafone Cash…)",
  cash: "Cash",
  card: "Card",
  other: "Other",
};

export function priceText(c: Pick<Course, "price" | "currency">): string {
  return c.price === null ? "Price on request" : formatMoney(c.price, c.currency);
}

/** "12 sessions × 2 h · 4 weeks · Online" */
export function courseFacts(c: Course): string {
  const parts: string[] = [];
  if (c.sessionsCount) parts.push(`${c.sessionsCount} session${c.sessionsCount === 1 ? "" : "s"}${c.sessionHours ? ` × ${c.sessionHours} h` : ""}`);
  if (c.durationWeeks) parts.push(`${c.durationWeeks} week${c.durationWeeks === 1 ? "" : "s"}`);
  parts.push(DELIVERY_LABEL[c.delivery]);
  return parts.join(" · ");
}

export function courseOf(ref: Reference, id: string | null | undefined) {
  return id ? ref.courses.find((c) => c.id === id) : undefined;
}

export function courseTypeOf(ref: Reference, course: Course | undefined) {
  return course?.courseTypeId ? ref.courseTypes.find((t) => t.id === course.courseTypeId) : undefined;
}
