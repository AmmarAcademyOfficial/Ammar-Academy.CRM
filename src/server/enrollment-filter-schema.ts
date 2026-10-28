import { z } from "zod";

const uuid = z.string().uuid();
const day = z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).default("");

/** The Enrollments list filters as the API accepts them (shared by the list and the Excel download). */
export const enrollmentFiltersSchema = z.object({
  search: z.string().max(100).default(""),
  programIds: z.array(uuid).max(50).default([]),
  courseTypeIds: z.array(uuid).max(50).default([]),
  courseIds: z.array(uuid).max(200).default([]),
  teacherIds: z.array(uuid).max(100).default([]),
  salesAgentIds: z.array(z.union([uuid, z.literal("none")])).max(100).default([]),
  supportOwnerIds: z.array(z.union([uuid, z.literal("none")])).max(100).default([]),
  statuses: z.array(z.enum(["not_handed_over", "new_customer", "onboarding", "active", "flagged", "withdrawn"])).default([]),
  paymentStates: z.array(z.enum(["paid", "balance", "overdue", "pending", "none", "refunded"])).default([]),
  currency: z.string().regex(/^([A-Z]{3})?$/).default(""),
  enrolledFrom: day, enrolledTo: day, startFrom: day, startTo: day,
});

export const enrollmentSortSchema = z.object({
  key: z.enum(["customer", "course", "enrolled", "start", "sales", "support", "paid", "balance", "next_due", "overdue", "last_paid"]),
  dir: z.enum(["asc", "desc"]),
});

export const enrollmentListQuerySchema = z.object({
  filters: enrollmentFiltersSchema,
  scope: z.enum(["mine", "all"]).optional(),
  sort: enrollmentSortSchema,
  page: z.number().int().min(0).max(10_000),
  pageSize: z.number().int().min(5).max(100),
});

export const enrollmentExportQuerySchema = z.object({
  filters: enrollmentFiltersSchema,
  sort: enrollmentSortSchema,
});
