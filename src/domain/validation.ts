/**
 * Shared validation schemas used by forms and server actions.
 */
import { z } from "zod";
import { isValidPhone } from "./rules";

const requiredText = (label: string, max = 200) =>
  z.string().trim().min(1, `${label} is required`).max(max, `${label} is too long`);

export const phoneSchema = z
  .string()
  .trim()
  .min(1, "Phone number is required")
  .refine(isValidPhone, "Enter a valid phone number (8–15 digits)");

export const newCustomerSchema = z.object({
  name: requiredText("Name", 120),
  phone: phoneSchema,
  programId: z.string().min(1, "Choose a program"),
  contactType: z.enum(["student", "parent", "other"]),
  studentName: z.string().trim().max(120).optional(),
  courseId: z.string().optional(),
  phoneSecondary: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || isValidPhone(v), "Enter a valid additional number"),
});
export type NewCustomerInput = z.infer<typeof newCustomerSchema>;

export const noteSchema = z.object({
  body: requiredText("Note", 4000),
});

export const contactAttemptSchema = z.object({
  outcomeId: z.string().min(1, "Choose the outcome"),
  body: z.string().trim().max(4000).optional(),
});

export const followUpSchema = z.object({
  dueAt: z.string().min(1, "Choose a date and time"),
  note: requiredText("What to do", 300),
});

export const lostReasonSchema = requiredText("Lost reason", 300);

export const rejectionSchema = requiredText("Reason", 300);

export const fieldDefinitionSchema = z.object({
  label: requiredText("Label", 60),
  type: z.enum(["text", "phone", "number", "date", "dropdown", "checkbox"]),
  importance: z.enum(["essential", "standard", "additional"]),
  requiredFrom: z.string(),
  programIds: z.array(z.string()),
  visibleTo: z.array(z.enum(["manager", "sales", "support"])).min(1, "At least one role must see the field"),
  editableBy: z.array(z.enum(["manager", "sales", "support"])),
  options: z.array(z.object({ id: z.string(), label: z.string().trim().min(1), archived: z.boolean() })),
});

/** Returns the first error message per field, or null when valid. */
export function fieldErrors<T>(schema: z.ZodType<T>, input: unknown): Record<string, string> | null {
  const r = schema.safeParse(input);
  if (r.success) return null;
  const out: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join(".") || "_";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
