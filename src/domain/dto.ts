/**
 * Shapes sent from the server to the browser. Everything here has already
 * passed row-level security for the signed-in user.
 */
import type { IneligibleReason } from "./rules";
import type {
  Activity,
  AppNotification,
  PaymentDue,
  NotificationRule,
  AuditEntry,
  Course,
  CourseType,
  ChecklistTemplateItem,
  Enrollment,
  Onboarding,
  PaymentSubmission,
  SupportFollowUp,
  Contact,
  ContactOutcome,
  FieldDefinition,
  FieldValue,
  FollowUp,
  ID,
  Inquiry,
  LeadFilters,
  Profile,
  Program,
  Role,
  SavedView,
  Settings,
  Stage,
  Tag,
} from "./types";

export interface Me {
  id: ID;
  fullName: string;
  email: string;
  role: Role;
  paused: boolean;
}

/** Small, slowly changing data every screen needs. Loaded once per page load. */
export interface Reference {
  profiles: Profile[];
  programs: Program[];
  courses: Course[];
  courseTypes: CourseType[];
  checklist: ChecklistTemplateItem[];
  stages: Stage[];
  outcomes: ContactOutcome[];
  tags: Tag[];
  fields: FieldDefinition[];
  settings: Settings;
  savedViews: SavedView[];
  leadColumns: string[] | null;
  notificationRules: NotificationRule[];
}

export interface LeadRowDTO {
  inquiry: Inquiry;
  contact: Contact;
  nextFollowUp?: FollowUp;
}

export type LeadSortKey = "name" | "program" | "stage" | "outcome" | "followup" | "owner" | "lastContact" | "created";

export interface LeadQuery {
  filters: LeadFilters;
  sort: { key: LeadSortKey; dir: "asc" | "desc" };
  page: number;
  pageSize: number;
}

export interface LeadPage {
  rows: LeadRowDTO[];
  total: number;
}

export interface PaymentTotalsDTO {
  agreed: number;
  paid: number;
  pending: number;
  balance: number;
}

export interface LeadDetail {
  row: LeadRowDTO;
  enrollment?: Enrollment;
  payments: PaymentSubmission[];
  totals?: PaymentTotalsDTO;
  /** The customer's payment plan, earliest first. */
  dues: PaymentDue[];
  onboarding?: Onboarding;
  supportFollowUps: SupportFollowUp[];
  activities: Activity[];
  followUps: FollowUp[];
  fieldValues: Record<ID, FieldValue>;
  /** Earlier inquiries of the same customer (newest first). */
  earlier: EarlierInquiry[];
}

export interface EarlierInquiry {
  inquiryId: ID;
  programCode: string;
  createdAt: string;
  ownerName: string | null;
  stageLabel: string;
  /** Whether the viewer may open it. */
  visible: boolean;
}

export type WorkBucket = "overdue" | "today" | "uncontacted" | "new" | "payment" | "noaction";

export interface MyWork {
  counts: Record<WorkBucket, number>;
  rows: LeadRowDTO[];
}

export interface FollowUpItem {
  followUp: FollowUp;
  lead: LeadRowDTO;
}

export interface Overview {
  newToday: number;
  queue: LeadRowDTO[];
  overdueFollowUps: number;
  openByAgent: { userId: ID; open: number; overdue: number }[];
  audit: AuditEntry[];
  /** Every sales agent × active program, right now. reason null = eligible. */
  eligibility: EligibilityRow[];
  sheets: SheetHealth[];
  reviewOpen: number;
  paymentsPending: number;
  onboardingFlagged: number;
}

/** One row of the manager's payments queue. */
export interface PaymentQueueRow {
  payment: PaymentSubmission;
  inquiryId: ID;
  customerName: string;
  programId: ID;
  courseId: ID;
  currency: string;
  salesOwnerId: ID | null;
  totals: PaymentTotalsDTO;
}

export interface PaymentsPage {
  rows: PaymentQueueRow[];
  counts: { pending: number; confirmedToday: number; confirmedThisMonth: { currency: string; amount: number }[] };
  flagged: CustomerRow[];
}

/** A handed-over customer, for support lists and the Customers page. */
export interface CustomerRow {
  onboarding: Onboarding;
  inquiryId: ID;
  customerName: string;
  phone: string;
  studentName?: string;
  programId: ID;
  courseId: ID;
  salesOwnerId: ID | null;
  totals: PaymentTotalsDTO;
  currency: string;
  nextDue?: { label: string; dueAt: string; kind: "checklist" | "follow_up" };
  /** The earliest planned payment not yet paid. */
  nextPayment?: PaymentDue;
}

/** A planned payment in the support / manager "Payments due" list. */
export interface PaymentDueRow extends PaymentDue {
  customerName: string;
  supportOwnerId: ID | null;
}

export interface SupportWork {
  queue: CustomerRow[];
  mine: CustomerRow[];
  followUps: (SupportFollowUp & { customerName: string; inquiryId: ID })[];
  overdueItems: { inquiryId: ID; customerName: string; label: string; dueAt: string; onboardingId: ID }[];
}

export interface EligibilityRow {
  userId: ID;
  programId: ID;
  reason: IneligibleReason | null;
  openLeads: number;
  onShiftUntil: string | null;
}

export interface SheetHealth {
  id: ID;
  name: string;
  tab: string;
  status: SheetStatus;
  statusMessage: string | null;
  lastSuccessAt: string | null;
  lastCheckedAt: string | null;
}

export type SheetStatus = "active" | "paused" | "needs_attention" | "reconnect" | "unavailable";

export interface GoogleAccountDTO {
  id: ID;
  email: string;
  status: "connected" | "reconnect" | "disconnected";
  lastError: string | null;
  connectedAt: string;
}

export interface SheetConnectionDTO extends SheetHealth {
  googleAccountId: ID;
  spreadsheetId: string;
  sheetGid: number;
  programId: ID;
  headerRow: number;
  headers: string[];
  mapping: { column: number; header: string; target: string }[];
  identity: "lead_id" | "timestamp_phone" | "phone_program";
  importMode: "all" | "new_only";
  rowsImported: number;
  lastRun: { imported: number; resubmitted: number; review: number; failed: number; remaining: number; at: string } | null;
  createdAt: string;
}

export interface SheetsPageData {
  mode: "real" | "fake" | "off";
  accounts: GoogleAccountDTO[];
  connections: SheetConnectionDTO[];
  reviewOpen: number;
}

export interface ReviewItemDTO {
  id: ID;
  connectionId: ID | null;
  connectionName: string | null;
  connectionTab: string | null;
  rowNumber: number | null;
  problems: string[];
  raw: Record<string, string>;
  parsed: { name?: string; phone?: string; phone_normalized?: string; program_id?: string; student_name?: string | null; contact_type?: string };
  status: "open" | "imported" | "dismissed";
  resolutionNote: string | null;
  resolvedBy: ID | null;
  resolvedAt: string | null;
  inquiryId: ID | null;
  createdAt: string;
}

export interface ShiftDTO {
  id: ID;
  userId: ID;
  weekday: number;
  start: string;
  end: string;
  programIds: ID[];
}

export interface TimeOffDTO {
  id: ID;
  userId: ID;
  startsOn: string;
  endsOn: string;
  reason: string | null;
}

export interface DistributionData {
  shifts: ShiftDTO[];
  timeOff: TimeOffDTO[];
  eligibility: EligibilityRow[];
  rotation: { programId: ID; lastUserId: ID | null; lastAssignedAt: string | null }[];
}

export interface NotificationList {
  items: AppNotification[];
  unread: number;
}

// ── Reports (Phase 5) ────────────────────────────────────────────────────

export interface MoneyTotal { currency: string; amount: number }
export interface LabelCount { label: string; count: number }

export interface ReportAgentRow {
  userId: ID; name: string; active: boolean;
  assigned: number; contacted: number; medianWorkingMinutes: number | null;
  assignedNowEnrolled: number; enrollments: number; confirmed: MoneyTotal[]; openNow: number;
}
export interface ReportCourseRow { courseId: ID; name: string; courseTypeId: ID | null; programId: ID; price: number | null; inquiries: number; enrollments: number; confirmed: MoneyTotal[] }
export interface ReportCourseTypeRow { courseTypeId: ID; name: string; color: string; inquiries: number; enrollments: number; confirmed: MoneyTotal[] }

export interface ReportData {
  range: { from: string; to: string };
  firstContactTargetMinutes: number;
  newInquiries: number;
  distinctContacts: number;
  daily: { day: string; inquiries: number; enrollments: number }[];
  firstContact: { medianWorkingMinutes: number | null; medianClockMinutes: number | null; measured: number; withinTarget: number; notYet: number };
  enrollments: number;
  confirmed: (MoneyTotal & { count: number })[];
  overdueFollowUps: number;
  overdueByOwner: LabelCount[];
  awaitingOnboarding: number;
  flaggedNow: number;
  assignedTotal: number;
  byStage: (LabelCount & { key: string })[];
  bySource: LabelCount[];
  lostReasons: LabelCount[];
  lostTotal: number;
  agents: ReportAgentRow[];
  courses: ReportCourseRow[];
  inquiriesWithoutCourse: number;
  courseTypes: ReportCourseTypeRow[];
  support: { handedOver: number; claimed: number; medianClaimMinutes: number | null; activated: number };
}
