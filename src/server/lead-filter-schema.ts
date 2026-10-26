import { z } from "zod";

/** The Leads list filters as the API accepts them (shared by the list and the matching-ids route). */
export const leadFiltersSchema = z.object({
  search: z.string().max(100).default(""),
  programIds: z.array(z.string().uuid()).default([]),
  stageKeys: z.array(z.enum(["new", "contacting", "qualified", "awaiting_payment", "enrolled", "lost", "invalid"])).default([]),
  outcomeIds: z.array(z.string().uuid()).default([]),
  tagIds: z.array(z.string().uuid()).default([]),
  primaryColors: z.array(z.enum(["orange", "blue", "purple", "red", "green", "teal", "gray"])).default([]),
  ownerIds: z.array(z.union([z.string().uuid(), z.literal("unassigned")])).default([]),
  courseIds: z.array(z.union([z.string().uuid(), z.literal("none")])).default([]),
  courseTypeIds: z.array(z.string().uuid()).default([]),
  followUp: z.enum(["any", "today", "overdue", "none", "upcoming"]).default("any"),
  uncontactedOnly: z.boolean().default(false),
  unopenedOnly: z.boolean().default(false),
  dateField: z.enum(["created", "assigned", "followUp", "lastContact"]).default("created"),
  dateFrom: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).default(""),
  dateTo: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).default(""),
});
