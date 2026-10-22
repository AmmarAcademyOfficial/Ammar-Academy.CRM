import "server-only";
import type { LeadRowDTO } from "@/domain/dto";
import type {
  Activity,
  ActivityType,
  AppNotification,
  AuditEntry,
  ChecklistTemplateItem,
  ContactOutcome,
  Course,
  CourseType,
  Enrollment,
  Onboarding,
  PaymentSubmission,
  SupportFollowUp,
  FieldDefinition,
  FollowUp,
  Profile,
  Program,
  Role,
  Settings,
  Stage,
  Tag,
} from "@/domain/types";

/** Database rows (snake_case) → domain objects (camelCase). Dates become ISO strings. */
type Row = Record<string, unknown>;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOpt = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : iso(v));
const str = (v: unknown): string => String(v);
const strOpt = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const arr = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.replace(/^\{|\}$/g, "").split(",").filter(Boolean);
  return [];
};

export const mapProfile = (r: Row): Profile => ({
  id: str(r.id),
  fullName: str(r.full_name),
  email: str(r.email),
  role: r.role as Role,
  active: Boolean(r.active),
  rotationOrder: Number(r.rotation_order),
  paused: Boolean(r.paused),
  maxOpenLeads: r.max_open_leads === null ? null : Number(r.max_open_leads),
});

export const mapProgram = (r: Row): Program => ({ id: str(r.id), code: str(r.code), name: str(r.name), active: Boolean(r.active) });

const num = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));
/** A DATE column → "YYYY-MM-DD" (postgres.js returns Date at local midnight UTC for dates). */
const day = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : iso(v).slice(0, 10));

export const mapCourseType = (r: Row): CourseType => ({
  id: str(r.id),
  name: str(r.name),
  description: strOpt(r.description),
  color: r.color as CourseType["color"],
  order: Number(r.sort),
  archived: Boolean(r.archived),
});

export const mapCourse = (r: Row): Course => ({
  id: str(r.id),
  programId: str(r.program_id),
  courseTypeId: r.course_type_id ? str(r.course_type_id) : null,
  name: str(r.name),
  price: r.price === null || r.price === undefined ? null : Number(r.price),
  currency: str(r.currency),
  description: strOpt(r.description),
  delivery: r.delivery as Course["delivery"],
  durationWeeks: num(r.duration_weeks),
  sessionsCount: num(r.sessions_count),
  sessionHours: num(r.session_hours),
  schedule: strOpt(r.schedule),
  startDate: day(r.start_date),
  endDate: day(r.end_date),
  capacity: num(r.capacity),
  active: Boolean(r.active),
});

export const mapChecklistItem = (r: Row): ChecklistTemplateItem => ({
  id: str(r.id),
  label: str(r.label),
  order: Number(r.sort),
  dueAfterDays: r.due_after_days === null ? null : Number(r.due_after_days),
  archived: Boolean(r.archived),
});

export const mapEnrollment = (r: Row): Enrollment => ({
  id: str(r.id),
  inquiryId: str(r.inquiry_id),
  courseId: str(r.course_id),
  agreedTotal: Number(r.agreed_total),
  currency: str(r.currency),
  priceNote: strOpt(r.price_note),
  originalSalesOwnerId: r.original_sales_owner_id ? str(r.original_sales_owner_id) : null,
  createdAt: iso(r.created_at),
  version: Number(r.version),
});

export const mapPayment = (r: Row): PaymentSubmission => ({
  id: str(r.id),
  enrollmentId: str(r.enrollment_id),
  amount: Number(r.amount),
  paidOn: day(r.paid_on)!,
  method: r.method as PaymentSubmission["method"],
  reference: strOpt(r.reference),
  receiptName: strOpt(r.receipt_name),
  hasReceipt: Boolean(r.receipt_path),
  note: strOpt(r.note),
  submittedById: str(r.submitted_by),
  submittedAt: iso(r.submitted_at),
  status: r.status as PaymentSubmission["status"],
  decidedById: strOpt(r.decided_by),
  decidedAt: isoOpt(r.decided_at),
  decisionReason: strOpt(r.decision_reason),
  reversedById: strOpt(r.reversed_by),
  reversedAt: isoOpt(r.reversed_at),
  reversalReason: strOpt(r.reversal_reason),
});

export const mapOnboarding = (r: Row, items: Row[]): Onboarding => ({
  id: str(r.id),
  enrollmentId: str(r.enrollment_id),
  supportOwnerId: r.support_owner_id ? str(r.support_owner_id) : null,
  status: r.status as Onboarding["status"],
  createdAt: iso(r.created_at),
  claimedAt: isoOpt(r.claimed_at),
  activatedAt: isoOpt(r.activated_at),
  flaggedForReview: strOpt(r.flagged_reason),
  supportOpenedAt: isoOpt(r.support_opened_at),
  version: Number(r.version),
  checklist: items.map((i) => ({
    templateItemId: str(i.template_item_id),
    label: str(i.label),
    dueAt: isoOpt(i.due_at),
    doneAt: isoOpt(i.done_at),
    doneById: strOpt(i.done_by),
  })),
});

export const mapSupportFollowUp = (r: Row): SupportFollowUp => ({
  id: str(r.id),
  onboardingId: str(r.onboarding_id),
  ownerId: r.owner_id ? str(r.owner_id) : null,
  dueAt: iso(r.due_at),
  note: str(r.note),
  status: r.status as SupportFollowUp["status"],
  completedAt: isoOpt(r.completed_at),
});

export const mapStage = (r: Row): Stage => ({
  id: str(r.id),
  systemKey: r.system_key as Stage["systemKey"],
  label: str(r.label),
  order: Number(r.sort),
  isClosed: Boolean(r.is_closed),
  agentSelectable: Boolean(r.agent_selectable),
});

export const mapOutcome = (r: Row): ContactOutcome => ({ id: str(r.id), systemKey: r.system_key as ContactOutcome["systemKey"], label: str(r.label), order: Number(r.sort) });

export const mapTag = (r: Row): Tag => ({ id: str(r.id), name: str(r.name), color: r.color as Tag["color"], archived: Boolean(r.archived) });

export const mapField = (r: Row, options: Row[]): FieldDefinition => ({
  id: str(r.id),
  key: str(r.key),
  label: str(r.label),
  type: r.type as FieldDefinition["type"],
  importance: r.importance as FieldDefinition["importance"],
  requiredFrom: r.required_from as FieldDefinition["requiredFrom"],
  programIds: arr(r.program_ids),
  visibleTo: arr(r.visible_to) as Role[],
  editableBy: arr(r.editable_by) as Role[],
  options: options.map((o) => ({ id: str(o.id), label: str(o.label), archived: Boolean(o.archived) })),
  order: Number(r.sort),
  archived: Boolean(r.archived),
  core: false,
});

export const mapSettings = (r: Row): Settings => ({
  agentsCanCreateTags: Boolean(r.agents_can_create_tags),
  agentsCanPause: Boolean(r.agents_can_pause),
  perAgentLeadCapEnabled: Boolean(r.per_agent_lead_cap_enabled),
  reminderMinutesBefore: Number(r.reminder_minutes_before),
  overdueAfterMinutes: Number(r.overdue_after_minutes),
  newLeadFirstContactTargetMinutes: Number(r.first_contact_target_minutes),
  handoverTrigger: r.handover_trigger as Settings["handoverTrigger"],
  depositRule: (r.deposit_rule ?? {}) as Settings["depositRule"],
  noteEditWindowMinutes: Number(r.note_edit_window_minutes),
  unopenedAlertMinutes: Number(r.unopened_alert_minutes ?? 30),
});

export const mapLeadRow = (r: Row): LeadRowDTO => ({
  inquiry: {
    id: str(r.id),
    contactId: str(r.contact_id),
    programId: str(r.program_id),
    studentName: strOpt(r.student_name),
    stageId: str(r.stage_id),
    lastOutcomeId: strOpt(r.last_outcome_id),
    salesOwnerId: r.sales_owner_id ? str(r.sales_owner_id) : null,
    tagIds: arr(r.tag_ids),
    primaryTagId: strOpt(r.primary_tag_id),
    source: r.source as "google_sheet" | "manual",
    sourceConnectionId: strOpt(r.source_connection_id),
    createdAt: iso(r.created_at),
    assignedAt: isoOpt(r.assigned_at),
    firstContactAttemptAt: isoOpt(r.first_contact_attempt_at),
    lastContactAt: isoOpt(r.last_contact_at),
    noFollowUpReason: strOpt(r.no_follow_up_reason),
    lostReason: strOpt(r.lost_reason),
    reserved: Boolean(r.reserved),
    reservedNote: strOpt(r.reserved_note),
    courseId: strOpt(r.course_id),
    version: Number(r.version),
    customFields: {},
    ownerOpenedAt: isoOpt(r.owner_opened_at),
    assignmentMethod: (r.assignment_method ?? undefined) as LeadRowDTO["inquiry"]["assignmentMethod"],
    returningCustomer: Boolean(r.returning_customer),
  },
  contact: {
    id: str(r.contact_id),
    name: str(r.c_name),
    phone: str(r.c_phone),
    phoneNormalized: str(r.c_phone_normalized),
    phoneSecondary: strOpt(r.c_phone_secondary),
    contactType: r.c_contact_type as "student" | "parent" | "other",
    doNotContact: Boolean(r.c_dnc),
    doNotContactReason: strOpt(r.c_dnc_reason),
    createdAt: iso(r.c_created_at),
  },
  nextFollowUp: r.nf_id
    ? { id: str(r.nf_id), inquiryId: str(r.id), ownerId: str(r.nf_owner_id), dueAt: iso(r.nf_due_at), note: str(r.nf_note), status: "open" }
    : undefined,
});

export const mapActivity = (r: Row, revisions: Row[]): Activity => ({
  id: str(r.id),
  inquiryId: str(r.inquiry_id),
  type: r.type as ActivityType,
  actorId: r.actor_id ? str(r.actor_id) : "system",
  body: strOpt(r.body),
  createdAt: iso(r.created_at),
  meta: (r.meta ?? {}) as Activity["meta"],
  revisions: revisions.length ? revisions.map((v) => ({ body: str(v.body), editedAt: iso(v.edited_at) })) : undefined,
});

export const mapFollowUp = (r: Row): FollowUp => ({
  id: str(r.id),
  inquiryId: str(r.inquiry_id),
  ownerId: str(r.owner_id),
  dueAt: iso(r.due_at),
  note: str(r.note),
  status: r.status as FollowUp["status"],
  completedAt: isoOpt(r.completed_at),
});

export const mapNotification = (r: Row): AppNotification => ({
  id: str(r.id),
  userId: str(r.user_id),
  text: str(r.text),
  inquiryId: strOpt(r.inquiry_id),
  createdAt: iso(r.created_at),
  read: r.read_at !== null && r.read_at !== undefined,
  kind: strOpt(r.kind),
  popup: Boolean(r.popup),
});

export const mapAudit = (r: Row): AuditEntry => ({ id: str(r.id), actorId: r.actor_id ? str(r.actor_id) : "system", action: str(r.action), target: str(r.target), createdAt: iso(r.created_at) });
