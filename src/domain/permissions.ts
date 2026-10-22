/**
 * Role permissions in one place.
 *
 * Phase 1: the prototype hides data with these functions.
 * Phase 2: the same rules are enforced by PostgreSQL row-level security
 * policies and re-checked in server actions. Hiding a button is never the
 * only protection.
 */
import type { FieldDefinition, ID, Inquiry, Onboarding, Enrollment, Role } from "./types";

export type Action =
  | "inquiry.create"
  | "inquiry.reassign"
  | "inquiry.viewAll"
  | "payment.submit"
  | "payment.decide"
  | "support.claim"
  | "support.updateStatus"
  | "tag.create"
  | "doNotContact.remove"
  | "settings.manage"
  | "reports.view"
  | "review.manage"
  | "user.pause.self";

const MATRIX: Record<Role, Action[]> = {
  manager: [
    "inquiry.create",
    "inquiry.reassign",
    "inquiry.viewAll",
    "payment.submit",
    "payment.decide",
    "support.claim",
    "support.updateStatus",
    "tag.create",
    "doNotContact.remove",
    "settings.manage",
    "reports.view",
    "review.manage",
  ],
  sales: ["inquiry.create", "payment.submit", "user.pause.self"],
  support: ["support.claim", "support.updateStatus"],
  accountant: ["payment.decide"],
};

export function can(role: Role, action: Action, opts?: { agentsCanCreateTags?: boolean }): boolean {
  if (action === "tag.create" && role === "sales") return !!opts?.agentsCanCreateTags;
  return MATRIX[role].includes(action);
}

export interface Viewer {
  id: ID;
  role: Role;
}

/** Sales records the viewer may see. Mirrors the `inquiries` RLS policy. */
export function canViewInquiry(
  viewer: Viewer,
  inquiry: Inquiry,
  supportLinks: { onboardings: Onboarding[]; enrollments: Enrollment[] },
): boolean {
  if (viewer.role === "manager") return true;
  if (viewer.role === "sales") return inquiry.salesOwnerId === viewer.id;
  // Support sees the sales history only for customers handed over to support.
  const enrollment = supportLinks.enrollments.find((e) => e.inquiryId === inquiry.id);
  if (!enrollment) return false;
  const ob = supportLinks.onboardings.find((o) => o.enrollmentId === enrollment.id);
  return !!ob && (ob.supportOwnerId === viewer.id || ob.supportOwnerId === null);
}

/** Support may edit only customers they own; the unassigned queue is a read-only preview. */
export function canWorkOnboarding(viewer: Viewer, ob: Onboarding): boolean {
  if (viewer.role === "manager") return true;
  return viewer.role === "support" && ob.supportOwnerId === viewer.id;
}

export function canReadField(role: Role, f: FieldDefinition): boolean {
  return f.visibleTo.includes(role);
}

export function canEditField(role: Role, f: FieldDefinition): boolean {
  return f.editableBy.includes(role) && f.visibleTo.includes(role) && !f.archived;
}

export const ROLE_LABEL: Record<Role, string> = {
  manager: "Manager",
  sales: "Sales Agent",
  support: "Customer Support",
  accountant: "Accountant",
};
