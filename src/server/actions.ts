"use server";

/**
 * Every change the app makes. Each action:
 *   1. checks the session (requireStaff),
 *   2. validates input with the shared Zod schemas,
 *   3. calls one database function as the signed-in user, where permissions
 *      and business rules are enforced, all in one transaction.
 * Actions return a Result instead of throwing, so screens can show the message.
 */
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { normalizePhone } from "@/domain/rules";
import type { FieldDefinition, FieldValue, LeadFilters, Role, Settings, StageKey } from "@/domain/types";
import { contactAttemptSchema, fieldDefinitionSchema, fieldErrors, followUpSchema, lostReasonSchema, newCustomerSchema, noteSchema } from "@/domain/validation";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireStaff } from "./auth";
import { asSystem, asUser } from "./db";
import { env } from "./env";
import { attempt, type Result, ValidationError } from "./result";

const uuid = z.string().uuid();

function check<T>(schema: z.ZodType<T>, input: unknown): T {
  const errs = fieldErrors(schema, input);
  if (errs) throw new ValidationError(Object.values(errs)[0], Object.values(errs));
  return schema.parse(input);
}

/** Runs a database call as the signed-in staff member. */
async function run<T>(fn: (tx: Parameters<Parameters<typeof asUser>[1]>[0], staffId: string, role: Role) => Promise<T>): Promise<T> {
  const staff = await requireStaff();
  return asUser(staff.id, (tx) => fn(tx, staff.id, staff.role));
}

const refreshReference = () => revalidatePath("/", "layout");

// ── Customers and inquiries ──────────────────────────────────────────────

export async function createCustomer(input: unknown, assignTo: string | "queue" | null): Promise<Result<{ inquiryId: string; queued: boolean; matchedExisting: boolean; ownerId: string | null }>> {
  return attempt(async () => {
    const v = check(newCustomerSchema, input);
    const body = {
      name: v.name,
      phone: v.phone,
      phone_normalized: normalizePhone(v.phone),
      phone_secondary: v.phoneSecondary || null,
      phone_secondary_normalized: v.phoneSecondary ? normalizePhone(v.phoneSecondary) : null,
      program_id: v.programId,
      contact_type: v.contactType,
      student_name: v.studentName || null,
      assign_to: assignTo && assignTo !== "queue" ? check(uuid, assignTo) : null,
      custom: {},
    };
    const [r] = await run(async (tx) => {
      const rows = await tx<{ r: { inquiry_id: string; queued: boolean; matched_existing: boolean; owner_id: string | null } }[]>`select public.create_inquiry(${tx.json(body)}) as r`;
      // Optional course of interest, in the same transaction.
      if (v.courseId) await tx`select public.set_inquiry_course(${rows[0].r.inquiry_id}, ${check(uuid, v.courseId)}, null)`;
      return rows;
    });
    return { inquiryId: r.r.inquiry_id, queued: r.r.queued, matchedExisting: r.r.matched_existing, ownerId: r.r.owner_id ?? null };
  });
}

export async function addNote(inquiryId: string, body: string): Promise<Result<void>> {
  return attempt(async () => {
    const v = check(noteSchema, { body });
    await run((tx) => tx`select public.add_note(${check(uuid, inquiryId)}, ${v.body})`);
  });
}

export async function editNote(activityId: string, body: string): Promise<Result<void>> {
  return attempt(async () => {
    const v = check(noteSchema, { body });
    await run((tx) => tx`select public.edit_note(${check(uuid, activityId)}, ${v.body})`);
  });
}

export async function recordAttempt(inquiryId: string, outcomeId: string, body?: string): Promise<Result<void>> {
  return attempt(async () => {
    const v = check(contactAttemptSchema, { outcomeId, body });
    await run((tx) => tx`select public.record_contact_attempt(${check(uuid, inquiryId)}, ${check(uuid, v.outcomeId)}, ${v.body ?? null})`);
  });
}

export async function logShortcut(inquiryId: string, channel: "call" | "whatsapp"): Promise<Result<void>> {
  return attempt(async () => {
    await run((tx) => tx`select public.log_outreach_shortcut(${check(uuid, inquiryId)}, ${check(z.enum(["call", "whatsapp"]), channel)})`);
  });
}

export async function changeStage(inquiryId: string, stage: StageKey, expectedVersion: number, lostReason?: string): Promise<Result<number>> {
  return attempt(async () => {
    if (stage === "lost") check(lostReasonSchema, lostReason ?? "");
    const [r] = await run((tx) => tx<{ v: number }[]>`select public.change_stage(${check(uuid, inquiryId)}, ${stage}::public.stage_key, ${expectedVersion}, ${lostReason ?? null}) as v`);
    return r.v;
  });
}

export async function setTags(inquiryId: string, tagIds: string[], primaryTagId?: string): Promise<Result<void>> {
  return attempt(async () => {
    const ids = check(z.array(uuid).max(20), tagIds);
    await run((tx) => tx`select public.set_tags(${check(uuid, inquiryId)}, ${ids}::uuid[], ${primaryTagId ?? null})`);
  });
}

export async function setDoNotContact(inquiryId: string, on: boolean, reason?: string): Promise<Result<void>> {
  return attempt(async () => {
    await run((tx) => tx`select public.set_do_not_contact(${check(uuid, inquiryId)}, ${on}, ${reason ?? null})`);
  });
}

export async function setReserved(inquiryId: string, reserved: boolean, note?: string): Promise<Result<void>> {
  return attempt(async () => {
    await run((tx) => tx`select public.set_reserved(${check(uuid, inquiryId)}, ${reserved}, ${note ?? null})`);
  });
}

export async function saveFieldValues(inquiryId: string, values: Record<string, FieldValue>, expectedVersion: number): Promise<Result<number>> {
  return attempt(async () => {
    const [r] = await run((tx) => tx<{ v: number }[]>`select public.set_field_values(${check(uuid, inquiryId)}, ${tx.json(values as Record<string, string>)}, ${expectedVersion}) as v`);
    return r.v;
  });
}

export async function createFollowUp(inquiryId: string, dueAtIso: string, note: string): Promise<Result<void>> {
  return attempt(async () => {
    const v = check(followUpSchema, { dueAt: dueAtIso, note });
    await run((tx) => tx`select public.create_follow_up(${check(uuid, inquiryId)}, ${new Date(v.dueAt)}, ${v.note})`);
  });
}

export async function completeFollowUp(followUpId: string): Promise<Result<void>> {
  return attempt(async () => {
    await run((tx) => tx`select public.complete_follow_up(${check(uuid, followUpId)})`);
  });
}

export async function setNoFollowUpReason(inquiryId: string, reason: string): Promise<Result<void>> {
  return attempt(async () => {
    await run((tx) => tx`select public.set_no_follow_up_reason(${check(uuid, inquiryId)}, ${reason})`);
  });
}

export async function reassign(inquiryId: string, toUserId: string, reason: string): Promise<Result<void>> {
  return attempt(async () => {
    await run((tx) => tx`select public.reassign_inquiry(${check(uuid, inquiryId)}, ${check(uuid, toUserId)}, ${reason})`);
  });
}

// ── Tags ─────────────────────────────────────────────────────────────────

const tagColor = z.enum(["orange", "blue", "purple", "red", "green", "teal", "gray"]);

export async function createTag(name: string, color: string): Promise<Result<string>> {
  return attempt(async () => {
    const [r] = await run((tx) => tx<{ id: string }[]>`select public.create_tag(${name}, ${check(tagColor, color)}) as id`);
    refreshReference();
    return r.id;
  });
}

export async function updateTag(id: string, patch: { name: string; color: string; archived: boolean }): Promise<Result<void>> {
  return attempt(async () => {
    await run((tx) => tx`select public.update_tag(${check(uuid, id)}, ${patch.name}, ${check(tagColor, patch.color)}, ${patch.archived})`);
    refreshReference();
  });
}

// ── Settings ─────────────────────────────────────────────────────────────

export async function saveField(field: FieldDefinition, isNew: boolean): Promise<Result<string>> {
  return attempt(async () => {
    check(fieldDefinitionSchema, field);
    const body = {
      id: isNew ? null : field.id,
      label: field.label,
      type: field.type,
      importance: field.importance,
      required_from: field.requiredFrom,
      program_ids: field.programIds,
      visible_to: field.visibleTo,
      editable_by: field.editableBy,
      options: field.options.map((o) => ({ id: o.id.startsWith("new-") ? null : o.id, label: o.label, archived: o.archived })),
    };
    const [r] = await run((tx) => tx<{ id: string }[]>`select public.save_field_definition(${tx.json(body)}) as id`);
    refreshReference();
    return r.id;
  });
}

export async function setFieldArchived(id: string, archived: boolean): Promise<Result<void>> {
  return attempt(async () => {
    await run((tx) => tx`select public.set_field_archived(${check(uuid, id)}, ${archived})`);
    refreshReference();
  });
}

export async function moveField(id: string, dir: -1 | 1): Promise<Result<void>> {
  return attempt(async () => {
    await run((tx) => tx`select public.move_field(${check(uuid, id)}, ${dir})`);
    refreshReference();
  });
}

export async function renameStage(id: string, label: string): Promise<Result<void>> {
  return attempt(async () => {
    await run((tx) => tx`select public.rename_stage(${check(uuid, id)}, ${label})`);
    refreshReference();
  });
}

export async function moveStage(id: string, dir: -1 | 1): Promise<Result<void>> {
  return attempt(async () => {
    await run((tx) => tx`select public.move_stage(${check(uuid, id)}, ${dir})`);
    refreshReference();
  });
}

export async function renameOutcome(id: string, label: string): Promise<Result<void>> {
  return attempt(async () => {
    await run((tx) => tx`select public.rename_outcome(${check(uuid, id)}, ${label})`);
    refreshReference();
  });
}

export async function updateSettings(patch: Partial<Settings>): Promise<Result<void>> {
  return attempt(async () => {
    const map: Record<string, unknown> = {
      agents_can_create_tags: patch.agentsCanCreateTags,
      agents_can_pause: patch.agentsCanPause,
      per_agent_lead_cap_enabled: patch.perAgentLeadCapEnabled,
      reminder_minutes_before: patch.reminderMinutesBefore,
      overdue_after_minutes: patch.overdueAfterMinutes,
      first_contact_target_minutes: patch.newLeadFirstContactTargetMinutes,
      note_edit_window_minutes: patch.noteEditWindowMinutes,
      unopened_alert_minutes: patch.unopenedAlertMinutes,
      payment_due_soon_days: patch.paymentDueSoonDays,
      handover_trigger: patch.handoverTrigger,
      deposit_rule: patch.depositRule,
    };
    const body = Object.fromEntries(Object.entries(map).filter(([, v]) => v !== undefined));
    await run((tx) => tx`select public.update_settings(${tx.json(body as Record<string, string>)})`);
    refreshReference();
  });
}

// ── Opened ("New" highlight) ─────────────────────────────────────────────

/** The sales owner opened the lead: it stops being highlighted as new. Others opening it change nothing. */
export async function markLeadOpened(inquiryId: string): Promise<Result<boolean>> {
  return attempt(async () => {
    const [r] = await run((tx) => tx<{ ok: boolean }[]>`select public.mark_inquiry_opened(${check(uuid, inquiryId)}) as ok`);
    return Boolean(r?.ok);
  });
}

/** The support owner opened the customer: it stops being highlighted as new. */
export async function markCustomerOpened(inquiryId: string): Promise<Result<boolean>> {
  return attempt(async () => {
    const [r] = await run((tx) => tx<{ ok: boolean }[]>`select public.mark_onboarding_opened(${check(uuid, inquiryId)}) as ok`);
    return Boolean(r?.ok);
  });
}

// ── Staff accounts ───────────────────────────────────────────────────────

/** Same rules as the Supabase project (supabase/config.toml): 10+ characters, upper and lower case, a digit. */
const staffPassword = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(72, "Use at most 72 characters")
  .regex(/[a-z]/, "Include a lowercase letter")
  .regex(/[A-Z]/, "Include an uppercase letter")
  .regex(/[0-9]/, "Include a number");

const inviteSchema = z.object({
  fullName: z.string().trim().min(1, "Add the person's name").max(120),
  email: z.string().trim().email("Enter a valid email address"),
  role: z.enum(["manager", "sales", "support"]),
  // Optional: set a password now instead of emailing an invitation link.
  password: z.union([z.literal(""), staffPassword]).optional(),
});

async function appUrl(): Promise<string> {
  if (env().APP_URL) return env().APP_URL!;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

export async function inviteUser(input: unknown): Promise<Result<void>> {
  return attempt(async () => {
    const v = check(inviteSchema, input);
    const staff = await requireStaff();
    if (staff.role !== "manager") throw new ValidationError("Only managers can invite staff.");
    let userId: string;
    if (env().AUTH_MODE === "local") {
      // Local development: create the login row directly (no email is sent).
      const [u] = await asSystem((tx) => tx<{ id: string }[]>`insert into auth.users (email) values (${v.email.toLowerCase()}) on conflict (email) do update set email = excluded.email returning id`);
      userId = u.id;
    } else if (v.password) {
      // The manager chose the password: create a confirmed login, no email needed.
      const { data, error } = await supabaseAdmin().auth.admin.createUser({
        email: v.email,
        password: v.password,
        email_confirm: true,
        user_metadata: { full_name: v.fullName },
      });
      if (error || !data.user) throw new ValidationError(friendlyAuthError(error?.message) ?? "The account could not be created.");
      userId = data.user.id;
    } else {
      const { data, error } = await supabaseAdmin().auth.admin.inviteUserByEmail(v.email, {
        redirectTo: `${await appUrl()}/auth/confirm?next=/reset-password`,
        data: { full_name: v.fullName },
      });
      if (error || !data.user) throw new ValidationError(error?.message ?? "The invitation could not be sent.");
      userId = data.user.id;
    }
    await asUser(staff.id, (tx) => tx`select public.admin_create_profile(${userId}, ${v.fullName}, ${v.email}, ${v.role}::public.app_role)`);
    refreshReference();
  });
}

function friendlyAuthError(message: string | undefined): string | undefined {
  if (!message) return undefined;
  if (/already (been )?registered|already exists/i.test(message)) return "A login with this email already exists.";
  if (/password/i.test(message)) return `Supabase refused the password: ${message}`;
  return message;
}

/** Manager sets or resets a staff member's password. The password is never stored by the CRM or logged. */
export async function setUserPassword(userId: string, password: string): Promise<Result<void>> {
  return attempt(async () => {
    const id = check(uuid, userId);
    const pw = check(staffPassword, password);
    const staff = await requireStaff();
    if (staff.role !== "manager") throw new ValidationError("Only managers can set passwords.");
    if (env().AUTH_MODE !== "supabase") throw new ValidationError("Passwords are not used with local sign-in.");
    const [target] = await asSystem((tx) => tx<{ full_name: string }[]>`select full_name from public.profiles where id = ${id}`);
    if (!target) throw new ValidationError("User not found.");
    const { error } = await supabaseAdmin().auth.admin.updateUserById(id, { password: pw });
    if (error) throw new ValidationError(friendlyAuthError(error.message) ?? "The password could not be changed.");
    await asSystem((tx) => tx`insert into public.audit_log (actor_id, action, target) values (${staff.id}, 'Set a new password', ${target.full_name})`);
  });
}

export async function setUserActive(userId: string, active: boolean, redistribute = false): Promise<Result<void>> {
  return attempt(async () => {
    await run((tx) => tx`select public.set_user_active(${check(uuid, userId)}, ${active}, ${redistribute})`);
    if (env().AUTH_MODE === "supabase") {
      // Also block or restore the login itself.
      const { error } = await supabaseAdmin().auth.admin.updateUserById(userId, { ban_duration: active ? "none" : "876000h" });
      if (error) console.error("[crm] could not update login ban", error);
    }
    refreshReference();
  });
}

export async function setUserRole(userId: string, role: Role): Promise<Result<void>> {
  return attempt(async () => {
    await run((tx) => tx`select public.set_user_role(${check(uuid, userId)}, ${check(z.enum(["manager", "sales", "support"]), role)}::public.app_role)`);
    refreshReference();
  });
}

export async function setUserLeadCap(userId: string, cap: number | null): Promise<Result<void>> {
  return attempt(async () => {
    await run((tx) => tx`select public.set_user_lead_cap(${check(uuid, userId)}, ${cap})`);
    refreshReference();
  });
}

export async function setUserPaused(userId: string, paused: boolean): Promise<Result<void>> {
  return attempt(async () => {
    await run((tx) => tx`select public.set_user_paused(${check(uuid, userId)}, ${paused})`);
    refreshReference();
  });
}

// ── Personal preferences ─────────────────────────────────────────────────

export async function saveView(name: string, filters: LeadFilters): Promise<Result<void>> {
  return attempt(async () => {
    const n = check(z.string().trim().min(1, "Name the view.").max(60), name);
    await run((tx, me) => tx`insert into public.saved_views (user_id, name, filters) values (${me}, ${n}, ${tx.json(filters as unknown as Record<string, string>)})`);
    refreshReference();
  });
}

export async function deleteView(id: string): Promise<Result<void>> {
  return attempt(async () => {
    await run((tx, me) => tx`delete from public.saved_views where id = ${check(uuid, id)} and user_id = ${me}`);
    refreshReference();
  });
}

export async function setColumns(keys: string[]): Promise<Result<void>> {
  return attempt(async () => {
    const cols = check(z.array(z.string().max(30)).max(20), keys);
    await run((tx, me) => tx`
      insert into public.user_preferences (user_id, lead_columns, updated_at) values (${me}, ${cols}, now())
      on conflict (user_id) do update set lead_columns = excluded.lead_columns, updated_at = now()`);
    refreshReference();
  });
}

/** Manager: switch one notification type on or off for a role, and choose whether it pops up. */
export async function setNotificationRule(event: string, role: Role, enabled: boolean, popup: boolean): Promise<Result<void>> {
  return attempt(async () => {
    const ev = check(z.string().regex(/^[a-z_]{1,40}$/), event);
    const r = check(z.enum(["manager", "sales", "support"]), role);
    await run((tx) => tx`select public.set_notification_rule(${ev}, ${r}, ${Boolean(enabled)}, ${Boolean(popup)})`);
    refreshReference();
  });
}

export async function markNotificationsRead(): Promise<Result<void>> {
  return attempt(async () => {
    await run((tx) => tx`select public.mark_notifications_read()`);
  });
}
