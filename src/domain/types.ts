/**
 * Core domain types for Ammar Academy CRM.
 *
 * These mirror the approved Phase 0 data model. In Phase 2 they become the
 * shape of rows returned from Supabase; the prototype store uses them directly.
 */

export type Role = "manager" | "sales" | "support" | "accountant";

export type ID = string;

/** ISO 8601 timestamp, always stored in UTC. Displayed in Africa/Cairo time. */
export type Timestamp = string;

export interface Profile {
  id: ID;
  fullName: string;
  email: string;
  role: Role;
  active: boolean;
  /** Position in the round-robin order (sales only). */
  rotationOrder: number;
  /** Agent-controlled pause. Ends automatically at shift end. */
  paused: boolean;
  /** Optional cap on open inquiries. null = no cap. */
  maxOpenLeads: number | null;
}

export interface Program {
  id: ID;
  code: string; // "SAT", "IELTS"
  name: string;
  active: boolean;
}

export type CourseDelivery = "online" | "in_person" | "hybrid";

/** A kind of course the Academy sells: Group course, Private 1:1, Intensive… (manager-managed). */
export interface CourseType {
  id: ID;
  name: string;
  description?: string;
  color: TagColor;
  order: number;
  archived: boolean;
}

/** A course in the catalog. Leads link to one; enrollments use its price as the default. */
export interface Course {
  id: ID;
  programId: ID;
  courseTypeId: ID | null;
  name: string;
  /** null = price on request */
  price: number | null;
  currency: string;
  description?: string;
  delivery: CourseDelivery;
  durationWeeks?: number;
  sessionsCount?: number;
  sessionHours?: number;
  schedule?: string;
  startDate?: string; // YYYY-MM-DD
  endDate?: string;
  capacity?: number;
  active: boolean;
}

export type ContactType = "student" | "parent" | "other";

export interface Contact {
  id: ID;
  name: string;
  phone: string; // as entered
  phoneNormalized: string; // +20…
  phoneSecondary?: string;
  contactType: ContactType;
  doNotContact: boolean;
  doNotContactReason?: string;
  createdAt: Timestamp;
}

/**
 * Stable business meanings. Managers can rename the label of a stage,
 * but reports and workflows always use the systemKey.
 */
export type StageKey =
  | "new"
  | "contacting"
  | "qualified"
  | "awaiting_payment"
  | "enrolled"
  | "lost"
  | "invalid";

export interface Stage {
  id: ID;
  systemKey: StageKey;
  label: string;
  order: number;
  isClosed: boolean;
  /** Agents may select this stage manually. Enrolled is set by the system. */
  agentSelectable: boolean;
}

export type OutcomeKey =
  | "no_answer"
  | "busy"
  | "reached"
  | "requested_callback"
  | "wrong_number";

export interface ContactOutcome {
  id: ID;
  systemKey: OutcomeKey;
  label: string;
  order: number;
}

export type TagColor =
  | "orange"
  | "blue"
  | "purple"
  | "red"
  | "green"
  | "teal"
  | "gray";

export interface Tag {
  id: ID;
  name: string;
  color: TagColor;
  archived: boolean;
}

export type LeadSource = "google_sheet" | "manual";

export interface Inquiry {
  id: ID;
  contactId: ID;
  programId: ID;
  studentName?: string;
  stageId: ID;
  lastOutcomeId?: ID;
  salesOwnerId: ID | null;
  tagIds: ID[];
  primaryTagId?: ID;
  source: LeadSource;
  sourceConnectionId?: ID;
  createdAt: Timestamp;
  assignedAt?: Timestamp;
  firstContactAttemptAt?: Timestamp;
  lastContactAt?: Timestamp;
  noFollowUpReason?: string;
  lostReason?: string;
  reserved: boolean;
  reservedNote?: string;
  /** Course of interest (from the catalog, same program). */
  courseId?: ID;
  /** Optimistic-concurrency version, incremented on every save. */
  version: number;
  customFields: Record<ID, FieldValue>;
  /** When the current sales owner first opened it; unset = still "new" (highlighted). */
  ownerOpenedAt?: Timestamp;
  assignmentMethod?: "round_robin" | "manual" | "creator" | "returning";
  /** The same customer had an earlier inquiry. */
  returningCustomer?: boolean;
}

export type ActivityType =
  | "comment"
  | "contact_attempt"
  | "stage_change"
  | "owner_change"
  | "follow_up_created"
  | "follow_up_completed"
  | "payment_submitted"
  | "payment_decision"
  | "handover"
  | "checklist"
  | "support_status"
  | "tag_change"
  | "do_not_contact"
  | "imported"
  | "resubmitted"
  | "outreach_shortcut"
  | "field_change"
  | "reservation"
  | "enrollment"
  | "support_assignment"
  | "support_follow_up"
  | "payment_plan"
  | "teacher"
  | "session";

export interface Activity {
  id: ID;
  inquiryId: ID;
  type: ActivityType;
  actorId: ID | "system";
  body?: string;
  createdAt: Timestamp;
  meta?: Record<string, string | number | boolean | null | undefined>;
  /** Present when the note was edited; earlier versions are kept. */
  revisions?: { body: string; editedAt: Timestamp }[];
}

export type FollowUpStatus = "open" | "done" | "cancelled";

export interface FollowUp {
  id: ID;
  inquiryId: ID;
  onboardingId?: ID;
  ownerId: ID;
  dueAt: Timestamp;
  note: string;
  status: FollowUpStatus;
  completedAt?: Timestamp;
}

export type SubmissionStatus = "pending" | "confirmed" | "rejected" | "reversed";
export type PaymentStatus = "unpaid" | "partially_paid" | "fully_paid";

export interface Enrollment {
  id: ID;
  inquiryId: ID;
  courseId: ID;
  agreedTotal: number;
  currency: string;
  priceNote?: string;
  originalSalesOwnerId: ID | null;
  createdAt: Timestamp;
  version: number;
  /** Package hours used before the customer was added to the CRM (Part D). */
  packageHoursBefore: number;
  /** Phase 1: a second or later enrollment of the same customer. */
  additional: boolean;
  /** Entered through Add existing customer. */
  addedAsExisting: boolean;
  /** Review by the accountant or a manager (never blocks anything). */
  review: { status: "to_review" | "reviewed" | "queried"; reason: string; byId: ID | null; at: Timestamp | null; note: string | null };
}

export type PaymentMethod = "bank_transfer" | "instapay" | "mobile_wallet" | "cash" | "card" | "other";

export interface PaymentSubmission {
  id: ID;
  enrollmentId: ID;
  amount: number;
  paidOn: string; // YYYY-MM-DD
  method: PaymentMethod;
  reference?: string;
  /** Private file; opened through the CRM, which checks permission. */
  receiptName?: string;
  hasReceipt: boolean;
  note?: string;
  submittedById: ID;
  submittedAt: Timestamp;
  status: SubmissionStatus;
  decidedById?: ID;
  decidedAt?: Timestamp;
  decisionReason?: string;
  reversedById?: ID;
  reversedAt?: Timestamp;
  reversalReason?: string;
  /** Deposit, installment or full payment (older records were labelled automatically). */
  kind?: PaymentKind;
  /** Phase 1: one transfer split across a customer's enrollments shares this id. */
  splitGroup?: ID;
}

export type PaymentKind = "deposit" | "installment" | "full";

/** A teacher (a record, not a login). */
export interface Teacher {
  id: ID;
  fullName: string;
  phone?: string;
  email?: string;
  programIds: ID[];
  active: boolean;
  notes?: string;
}

/** A named hourly rate of one teacher. `amounts` is empty for staff who may not see pay. */
export interface TeacherRate {
  id: ID;
  teacherId: ID;
  name: string;
  currency: string;
  archived: boolean;
  /** Amount per hour from each date, newest first. */
  amounts: { amount: number; validFrom: string }[];
}

export type SessionStatus = "scheduled" | "done" | "cancelled_student" | "cancelled_teacher" | "no_show";

/** One teaching session. Paid and student hours are fixed when it is recorded. */
export interface TeachingSession {
  id: ID;
  assignmentId: ID;
  teacherId: ID;
  rateId: ID;
  enrollmentId?: ID;
  courseId?: ID;
  inquiryId?: ID;
  customerName?: string;
  supportOwnerId?: ID;
  subject?: string;
  startsAt: Timestamp;
  plannedHours: number;
  status: SessionStatus;
  hours?: number;
  lateCancel: boolean;
  paidHours: number;
  studentHours: number;
  note?: string;
  recordedById?: ID;
  recordedAt?: Timestamp;
  /** Sessions of one weekly series share this id (none for a single session). */
  seriesId?: ID;
}

/** A teacher and rate for a private customer (enrollment) or a group course. */
export interface TeacherAssignment {
  id: ID;
  teacherId: ID;
  rateId: ID;
  enrollmentId?: ID;
  courseId?: ID;
  subject?: string;
  startedOn: string;
  endedOn?: string;
  customerName?: string;
  inquiryId?: ID;
}

export type PaymentDueStatus = "paid" | "partly_paid" | "upcoming" | "due_today" | "overdue";

/** One expected payment in a customer's payment plan. */
export interface PaymentDue {
  id: ID;
  enrollmentId: ID;
  inquiryId: ID;
  dueOn: string; // YYYY-MM-DD
  amount: number;
  /** Confirmed money applied to this due so far. */
  covered: number;
  status: PaymentDueStatus;
  note?: string;
  currency: string;
}

export type SupportStatus = "new_customer" | "onboarding" | "active";

export interface ChecklistTemplateItem {
  id: ID;
  label: string;
  order: number;
  /** Days after handover the item is due. null = no due date. */
  dueAfterDays: number | null;
  archived: boolean;
}

export interface ChecklistItem {
  templateItemId: ID;
  label: string;
  dueAt?: Timestamp;
  doneAt?: Timestamp;
  doneById?: ID;
}

export interface Onboarding {
  id: ID;
  enrollmentId: ID;
  supportOwnerId: ID | null;
  status: SupportStatus;
  createdAt: Timestamp;
  claimedAt?: Timestamp;
  activatedAt?: Timestamp;
  checklist: ChecklistItem[];
  flaggedForReview?: string;
  /** When the support owner first opened the customer; unset = still "new" (highlighted). */
  supportOpenedAt?: Timestamp;
  version: number;
}

export interface SupportFollowUp {
  id: ID;
  onboardingId: ID;
  ownerId: ID | null;
  dueAt: Timestamp;
  note: string;
  status: FollowUpStatus;
  completedAt?: Timestamp;
}

// ── Custom fields ─────────────────────────────────────────────────────────

export type FieldType = "text" | "phone" | "number" | "date" | "dropdown" | "checkbox";
export type FieldImportance = "essential" | "standard" | "additional";
export type FieldValue = string | number | boolean | null;

export interface FieldOption {
  id: ID;
  label: string;
  archived: boolean;
}

export interface FieldDefinition {
  /** Stable internal ID. Never changes, even when the label is renamed. */
  id: ID;
  key: string;
  label: string;
  type: FieldType;
  importance: FieldImportance;
  /** "never" | "always" | a stage systemKey from which the field becomes required. */
  requiredFrom: "never" | "always" | StageKey;
  /** Empty = all programs. */
  programIds: ID[];
  visibleTo: Role[];
  editableBy: Role[];
  options: FieldOption[];
  order: number;
  archived: boolean;
  /** Core protected fields cannot be archived or have their type changed. */
  core: boolean;
}

// ── Distribution ──────────────────────────────────────────────────────────

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday

export interface Shift {
  id: ID;
  userId: ID;
  weekday: Weekday;
  /** Cairo wall-clock "HH:MM". If end <= start, the shift runs overnight. */
  start: string;
  end: string;
  programIds: ID[];
}

export interface TimeOff {
  id: ID;
  userId: ID;
  startsOn: string; // YYYY-MM-DD (Cairo)
  endsOn: string; // inclusive
  reason: string;
}

// ── Imports ───────────────────────────────────────────────────────────────

export interface SheetConnection {
  id: ID;
  name: string;
  spreadsheetUrl: string;
  tab: string;
  programId: ID;
  enabled: boolean;
  identityStrategy: "lead_id_column" | "fingerprint";
  mappings: { header: string; fieldKey: string }[];
  lastSuccessAt?: Timestamp;
  lastRun?: { imported: number; skipped: number; flagged: number; failed: number; at: Timestamp };
  lastError?: string;
}

export type ReviewKind = "invalid_row" | "duplicate_candidate" | "field_conflict" | "payment_reversal";

export interface ReviewItem {
  id: ID;
  kind: ReviewKind;
  title: string;
  detail: string;
  connectionId?: ID;
  inquiryId?: ID;
  createdAt: Timestamp;
  resolved: boolean;
}

// ── System ───────────────────────────────────────────────────────────────

export interface AppNotification {
  id: ID;
  userId: ID;
  text: string;
  inquiryId?: ID;
  createdAt: Timestamp;
  read: boolean;
  /** Notification type (see domain/notifications.ts). */
  kind?: string;
  /** Pops up with a sound when it arrives (decided by the notification rules). */
  popup?: boolean;
}

export interface NotificationRule {
  event: string;
  role: Role;
  enabled: boolean;
  popup: boolean;
}

export interface AuditEntry {
  id: ID;
  actorId: ID;
  action: string;
  target: string;
  createdAt: Timestamp;
}

export interface SavedView {
  id: ID;
  name: string;
  /** Built-in views cannot be deleted. */
  builtIn: boolean;
  filters: LeadFilters;
}

export interface LeadFilters {
  search: string;
  programIds: ID[];
  stageKeys: StageKey[];
  outcomeIds: ID[];
  tagIds: ID[];
  primaryColors: TagColor[];
  ownerIds: ID[];
  /** Course of interest; "none" = no course set. */
  courseIds: (ID | "none")[];
  courseTypeIds: ID[];
  followUp: "any" | "today" | "overdue" | "none" | "upcoming";
  uncontactedOnly: boolean;
  /** Assigned but not opened yet by the owner. */
  unopenedOnly?: boolean;
  /** Which date the custom range applies to. */
  dateField: DateFilterField;
  /** Inclusive Cairo calendar dates, "YYYY-MM-DD". Empty = open-ended. */
  dateFrom: string;
  dateTo: string;
}

export type DateFilterField = "created" | "assigned" | "followUp" | "lastContact";

export interface Settings {
  agentsCanCreateTags: boolean;
  agentsCanPause: boolean;
  perAgentLeadCapEnabled: boolean;
  reminderMinutesBefore: number;
  overdueAfterMinutes: number;
  newLeadFirstContactTargetMinutes: number;
  handoverTrigger: "qualifying_deposit" | "full_payment";
  /** Per program: minimum confirmed amount (EGP) or percent of agreed total. null = not yet set. */
  depositRule: Record<ID, { kind: "amount" | "percent"; value: number } | null>;
  noteEditWindowMinutes: number;
  /** Alert the owner and managers when an assigned lead is not opened after this long. 0 = off. */
  unopenedAlertMinutes: number;
  /** "Payment due soon" goes out this many days before a planned payment. 0 = off. */
  paymentDueSoonDays: number;
  /** A student cancellation this many hours or less before the session is "late". */
  lateCancelHours: number;
  /** Late student cancellations are paid to the teacher and use package hours. */
  lateCancelPaid: boolean;
  /** No-shows are paid to the teacher and use package hours. */
  noShowPaid: boolean;
}
