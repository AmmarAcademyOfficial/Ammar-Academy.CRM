"use client";

import { ArrowDown, ArrowUp, BarChart3, Calculator, ChevronRight, FileWarning, KeyRound, Lock, Plus, UserPlus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { StageBadge, TAG_COLORS, TagChip } from "@/components/ui/badges";
import { Button, IconButton } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { Field, Input, Select, Toggle } from "@/components/ui/form";
import { Card, CardHeader, PageHeader } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import { ROLE_LABEL } from "@/domain/permissions";
import type { Profile, Role, Settings, TagColor } from "@/domain/types";
import { useRunAction } from "@/lib/run-action";
import { useWorkspace } from "@/lib/workspace";
import {
  createTag,
  inviteUser,
  moveStage,
  renameOutcome,
  renameStage,
  setUserActive,
  setUserLeadCap,
  setUserPassword,
  setUserRole,
  updateSettings,
  updateTag,
} from "@/server/actions";
import { DeletedItemsView } from "@/features/deleted/deleted-items";
import { AuditSettings } from "./audit-settings";
import { ChecklistSettings } from "./checklist-settings";
import { CoursesSettings } from "./courses-settings";
import { FieldsSettings } from "./fields-settings";
import { NotificationsSettings } from "./notifications-settings";
import { SheetsSettings } from "./sheets-settings";
import { ShiftsSettings } from "./shifts-settings";
import { TeachersSettings } from "./teachers-settings";

const SECTIONS = [
  { id: "users", label: "Users and Roles" },
  { id: "shifts", label: "Shifts and Distribution" },
  { id: "courses", label: "Courses and Prices" },
  { id: "teachers", label: "Teachers and Rates" },
  { id: "fields", label: "Customer Fields" },
  { id: "stages", label: "Stages and Contact Outcomes" },
  { id: "tags", label: "Tags and Colors" },
  { id: "followups", label: "Follow-ups" },
  { id: "notifications", label: "Notifications" },
  { id: "payments", label: "Payments and Handover" },
  { id: "checklist", label: "Support Checklist" },
  { id: "sheets", label: "Google Sheets Connections" },
  { id: "audit", label: "Audit History" },
  { id: "deleted", label: "Deleted items" },
] as const;

export function SettingsPage({ section }: { section?: string }) {
  const current = SECTIONS.find((s) => s.id === section);
  return (
    <div>
      <PageHeader title="Settings" subtitle="Manager-only configuration. Changes here apply to everyone." />
      <div className="mb-4 grid grid-cols-2 gap-2 lg:hidden">
        <Link href="/accounting" className="flex items-center gap-2 rounded-xl border border-line bg-white px-3 py-3 text-sm font-medium"><Calculator size={16} aria-hidden /> Accounting</Link>
        <Link href="/reports" className="flex items-center gap-2 rounded-xl border border-line bg-white px-3 py-3 text-sm font-medium"><BarChart3 size={16} aria-hidden /> Reports</Link>
        <Link href="/review" className="flex items-center gap-2 rounded-xl border border-line bg-white px-3 py-3 text-sm font-medium"><FileWarning size={16} aria-hidden /> Needs Review</Link>
      </div>
      <div className="grid gap-5 lg:grid-cols-[240px_1fr]">
        <nav aria-label="Settings sections" className={clsx(current && "hidden lg:block")}>
          <ul className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-white lg:sticky lg:top-20">
            {SECTIONS.map((s, i) => (
              <li key={s.id} className={clsx(i > 0 && "border-t border-line")}>
                <Link href={`/settings/${s.id}`} aria-current={current?.id === s.id ? "page" : undefined} className={clsx("flex items-center gap-2 px-4 py-3 text-sm", current?.id === s.id ? "bg-navy-50 font-semibold text-navy-900" : "hover:bg-navy-50/60")}>
                  <span className="w-5 text-xs text-muted">{i + 1}.</span>
                  {s.label}
                  <ChevronRight size={14} className="ml-auto text-muted lg:hidden" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className={clsx(!current && "hidden lg:block")}>
          {current && (
            <div className="mb-4 flex items-center gap-2">
              <Link href="/settings" className="text-sm text-navy-700 hover:underline lg:hidden">← All settings</Link>
              <h2 className="text-lg font-semibold max-lg:hidden">{current.label}</h2>
            </div>
          )}
          {!current && <Card className="p-6 text-sm text-muted">Choose a section on the left.</Card>}
          {current?.id === "users" && <UsersSection />}
          {current?.id === "shifts" && <ShiftsSettings />}
          {current?.id === "courses" && <CoursesSettings />}
          {current?.id === "teachers" && <TeachersSettings />}
          {current?.id === "fields" && <FieldsSettings />}
          {current?.id === "stages" && <StagesSection />}
          {current?.id === "tags" && <TagsSection />}
          {current?.id === "followups" && <FollowUpSection />}
          {current?.id === "notifications" && <NotificationsSettings />}
          {current?.id === "payments" && <PaymentsSection />}
          {current?.id === "checklist" && <ChecklistSettings />}
          {current?.id === "sheets" && <SheetsSettings />}
          {current?.id === "audit" && <AuditSettings />}
          {current?.id === "deleted" && <DeletedItemsView />}
        </div>
      </div>
    </div>
  );
}

// ── Users ────────────────────────────────────────────────────────────────

function UsersSection() {
  const { me, ref } = useWorkspace();
  const runAction = useRunAction();
  const [inviting, setInviting] = useState(false);
  const [deactivating, setDeactivating] = useState<Profile | null>(null);
  const [passwordFor, setPasswordFor] = useState<Profile | null>(null);
  const people = [...ref.profiles].sort((a, b) => Number(b.active) - Number(a.active) || a.fullName.localeCompare(b.fullName));
  return (
    <Card>
      <CardHeader title="Staff accounts" subtitle="No public sign-up. Managers add staff and can set or reset their passwords." action={<Button size="sm" variant="primary" icon={<UserPlus size={14} />} onClick={() => setInviting(true)}>Add user</Button>} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line text-left text-xs text-muted"><th className="px-4 py-2 font-medium">Name</th><th className="px-3 py-2 font-medium">Role</th>{ref.settings.perAgentLeadCapEnabled && <th className="px-3 py-2 font-medium">Lead cap</th>}<th className="px-3 py-2 font-medium">Active</th><th className="px-3 py-2 font-medium">Password</th></tr></thead>
          <tbody>
            {people.map((u) => (
              <tr key={u.id} className="border-b border-line/70 last:border-0">
                <td className="px-4 py-2.5">
                  <p className={clsx("font-medium", !u.active && "text-muted")}>{u.fullName}{u.id === me.id && <span className="ml-1 text-xs font-normal text-muted">(you)</span>}</p>
                  <p className="text-xs text-muted" dir="ltr">{u.email}</p>
                </td>
                <td className="px-3 py-2.5">
                  <Select aria-label={`Role for ${u.fullName}`} value={u.role} onChange={(e) => runAction(setUserRole(u.id, e.target.value as Role), "Role changed", { reference: true })} className="h-8 w-auto py-0 text-[13px]">
                    {(["manager", "sales", "support", "accountant"] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </Select>
                </td>
                {ref.settings.perAgentLeadCapEnabled && (
                  <td className="px-3 py-2.5">
                    {u.role === "sales" ? (
                      <Input aria-label={`Lead cap for ${u.fullName}`} type="number" min={1} className="h-8 w-20" defaultValue={u.maxOpenLeads ?? ""} onBlur={(e) => runAction(setUserLeadCap(u.id, e.target.value ? Number(e.target.value) : null), "Lead cap saved", { reference: true })} />
                    ) : <span className="text-muted">—</span>}
                  </td>
                )}
                <td className="px-3 py-2.5">
                  <Toggle label={`${u.active ? "Deactivate" : "Activate"} ${u.fullName}`} checked={u.active} onChange={(v) => {
                    if (!v && u.role === "sales") setDeactivating(u);
                    else runAction(setUserActive(u.id, v), v ? "User reactivated" : "User deactivated. Their history is kept.", { reference: true });
                  }} />
                </td>
                <td className="px-3 py-2.5">
                  <Button size="sm" icon={<KeyRound size={14} />} disabled={!u.active} onClick={() => setPasswordFor(u)} aria-label={`Set password for ${u.fullName}`}>Set password</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-line px-4 py-2.5 text-xs text-muted">Deactivated staff cannot sign in; their notes and history stay. The last active manager cannot be deactivated or demoted.</p>
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
      {passwordFor && <SetPasswordDialog user={passwordFor} onClose={() => setPasswordFor(null)} />}
      {deactivating && (
        <Dialog
          open
          onClose={() => setDeactivating(null)}
          title={`Deactivate ${deactivating.fullName}?`}
          description="They will no longer be able to sign in or receive leads. Their notes and history stay. What should happen to their open leads?"
          footer={
            <>
              <Button onClick={() => setDeactivating(null)}>Cancel</Button>
              <Button onClick={async () => { const r = await runAction(setUserActive(deactivating.id, false, false), "User deactivated. Their open leads stay with them until you reassign.", { reference: true }); if (r.ok) setDeactivating(null); }}>Keep leads with them</Button>
              <Button variant="primary" onClick={async () => { const r = await runAction(setUserActive(deactivating.id, false, true), "User deactivated. Open leads were given to agents on shift (or wait in the queue).", { reference: true }); if (r.ok) setDeactivating(null); }}>Redistribute open leads</Button>
            </>
          }
        >
          <p className="text-sm text-muted">Redistributing returns each open lead to the queue and assigns it by round-robin to agents on shift. Follow-ups move with the lead.</p>
        </Dialog>
      )}
    </Card>
  );
}

const PASSWORD_HINT = "At least 10 characters, with an uppercase letter, a lowercase letter and a number.";

function passwordProblem(pw: string, confirm: string): string | null {
  if (pw.length < 10) return "Use at least 10 characters.";
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[0-9]/.test(pw)) return "Include an uppercase letter, a lowercase letter and a number.";
  if (pw !== confirm) return "The two passwords do not match.";
  return null;
}

function PasswordFields({ pw, confirm, onChange }: { pw: string; confirm: string; onChange: (pw: string, confirm: string) => void }) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-3">
      <Field label="Password" required hint={PASSWORD_HINT}>
        {(p) => <Input type={show ? "text" : "password"} dir="ltr" autoComplete="new-password" value={pw} onChange={(e) => onChange(e.target.value, confirm)} {...p} />}
      </Field>
      <Field label="Type the password again" required>
        {(p) => <Input type={show ? "text" : "password"} dir="ltr" autoComplete="new-password" value={confirm} onChange={(e) => onChange(pw, e.target.value)} {...p} />}
      </Field>
      <label className="flex items-center gap-2 text-sm text-muted">
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show password
      </label>
    </div>
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const runAction = useRunAction();
  const [form, setForm] = useState({ fullName: "", email: "", role: "sales" as Role });
  const [method, setMethod] = useState<"password" | "email">("password");
  const [pw, setPw] = useState({ pw: "", confirm: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (method === "password") {
      const p = passwordProblem(pw.pw, pw.confirm);
      setProblem(p);
      if (p) return;
    }
    setBusy(true);
    const r = await runAction(
      inviteUser({ ...form, password: method === "password" ? pw.pw : "" }),
      method === "password" ? `Account created for ${form.fullName}. Give them their password in person.` : `Invitation sent to ${form.email}`,
      { reference: true },
    );
    setBusy(false);
    if (r.ok) onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a staff member"
      description="Choose a password for them now, or email them a link to choose their own."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={submit}>{busy ? "Saving…" : method === "password" ? "Create account" : "Send invitation"}</Button></>}
    >
      <div className="space-y-4">
        <Field label="Full name" required>{(p) => <Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} {...p} />}</Field>
        <Field label="Work email" required>{(p) => <Input type="email" dir="ltr" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} {...p} />}</Field>
        <Field label="Role" required>
          {(p) => (
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })} {...p}>
              <option value="sales">Sales Agent</option>
              <option value="support">Customer Support</option>
              <option value="manager">Manager</option>
              <option value="accountant">Accountant (sees everything, records and reviews payments)</option>
            </Select>
          )}
        </Field>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">How will they sign in?</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="signin-method" className="mt-1" checked={method === "password"} onChange={() => setMethod("password")} />
            <span><span className="font-medium">Set a password now</span><span className="block text-xs text-muted">They can sign in straight away. Tell them the password in person, not by chat.</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="signin-method" className="mt-1" checked={method === "email"} onChange={() => setMethod("email")} />
            <span><span className="font-medium">Email them an invitation link</span><span className="block text-xs text-muted">They choose their own password from the email.</span></span>
          </label>
        </fieldset>
        {method === "password" && <PasswordFields pw={pw.pw} confirm={pw.confirm} onChange={(a, b) => { setPw({ pw: a, confirm: b }); setProblem(null); }} />}
        {problem && <p role="alert" className="text-sm text-red-700">{problem}</p>}
      </div>
    </Dialog>
  );
}

function SetPasswordDialog({ user, onClose }: { user: Profile; onClose: () => void }) {
  const runAction = useRunAction();
  const [pw, setPw] = useState({ pw: "", confirm: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const p = passwordProblem(pw.pw, pw.confirm);
    setProblem(p);
    if (p) return;
    setBusy(true);
    const r = await runAction(setUserPassword(user.id, pw.pw), `New password set for ${user.fullName}`);
    setBusy(false);
    if (r.ok) onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Set a new password for ${user.fullName}`}
      description="Their old password stops working immediately. Tell them the new one in person, not by chat."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={submit}>{busy ? "Saving…" : "Save password"}</Button></>}
    >
      <div className="space-y-4">
        <PasswordFields pw={pw.pw} confirm={pw.confirm} onChange={(a, b) => { setPw({ pw: a, confirm: b }); setProblem(null); }} />
        {problem && <p role="alert" className="text-sm text-red-700">{problem}</p>}
      </div>
    </Dialog>
  );
}

// ── Stages and outcomes ──────────────────────────────────────────────────

function StagesSection() {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const openStages = ref.stages.filter((s) => !s.isClosed);
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Sales stages" subtitle="Rename or reorder freely. The fixed meaning on the right keeps reports and payment rules working." />
        <ul className="divide-y divide-line">
          {ref.stages.map((s) => {
            const idx = openStages.indexOf(s);
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <div className="flex w-14">
                  {!s.isClosed && (
                    <>
                      <IconButton label={`Move ${s.label} up`} icon={<ArrowUp size={14} />} disabled={idx === 0} onClick={() => runAction(moveStage(s.id, -1), null, { reference: true })} className="h-7 w-7" />
                      <IconButton label={`Move ${s.label} down`} icon={<ArrowDown size={14} />} disabled={idx === openStages.length - 1} onClick={() => runAction(moveStage(s.id, 1), null, { reference: true })} className="h-7 w-7" />
                    </>
                  )}
                </div>
                <Input key={s.label} aria-label={`Label for ${s.systemKey}`} defaultValue={s.label} onBlur={(e) => e.target.value !== s.label && runAction(renameStage(s.id, e.target.value), "Stage renamed", { reference: true })} className="h-9 max-w-[220px]" />
                <StageBadge stage={s} />
                <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted"><Lock size={11} aria-hidden /> Meaning: <code className="rounded bg-navy-50 px-1">{s.systemKey}</code>{s.isClosed ? " · closed" : ""}{!s.agentSelectable ? " · set by payment" : ""}</span>
              </li>
            );
          })}
        </ul>
      </Card>
      <Card>
        <CardHeader title="Contact outcomes" subtitle="What happened on a contact attempt. Kept separate from stages." />
        <ul className="divide-y divide-line">
          {ref.outcomes.map((o) => (
            <li key={o.id} className="flex items-center gap-3 px-4 py-2.5">
              <Input key={o.label} aria-label={`Label for ${o.systemKey}`} defaultValue={o.label} onBlur={(e) => e.target.value !== o.label && runAction(renameOutcome(o.id, e.target.value), "Outcome renamed", { reference: true })} className="h-9 max-w-[220px]" />
              <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted"><Lock size={11} aria-hidden /> <code className="rounded bg-navy-50 px-1">{o.systemKey}</code></span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

// ── Tags ─────────────────────────────────────────────────────────────────

function TagsSection() {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const [name, setName] = useState("");
  const [color, setColor] = useState<TagColor>("green");
  return (
    <Card>
      <CardHeader title="Tags" subtitle="Tags and colors help agents organize work. They never verify a payment." />
      <label className="flex items-center justify-between gap-4 border-b border-line px-4 py-3 text-sm">
        <span>Agents can create new tags</span>
        <Toggle label="Agents can create new tags" checked={ref.settings.agentsCanCreateTags} onChange={(v) => runAction(updateSettings({ agentsCanCreateTags: v }), "Setting saved", { reference: true })} />
      </label>
      <ul className="divide-y divide-line">
        {ref.tags.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <TagChip tag={t} />
            <Select aria-label={`Color for ${t.name}`} value={t.color} onChange={(e) => runAction(updateTag(t.id, { name: t.name, color: e.target.value, archived: t.archived }), "Tag updated", { reference: true })} className="ml-auto h-8 w-auto py-0 text-[13px]">
              {Object.entries(TAG_COLORS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
            <Button size="sm" onClick={() => runAction(updateTag(t.id, { name: t.name, color: t.color, archived: !t.archived }), t.archived ? "Tag restored" : "Tag archived. History keeps it.", { reference: true })}>{t.archived ? "Restore" : "Archive"}</Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2 border-t border-line p-4">
        <Field label="New tag" className="flex-1">{(p) => <Input value={name} onChange={(e) => setName(e.target.value)} {...p} />}</Field>
        <Field label="Color">{(p) => <Select value={color} onChange={(e) => setColor(e.target.value as TagColor)} {...p}>{Object.entries(TAG_COLORS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>}</Field>
        <Button icon={<Plus size={16} />} onClick={async () => (await runAction(createTag(name, color), "Tag created", { reference: true })).ok && setName("")}>Add tag</Button>
      </div>
    </Card>
  );
}

// ── Follow-ups and notifications ─────────────────────────────────────────

export function NumberSetting({ label, hint, value, onSave, unit }: { label: string; hint: string; value: number; onSave: (n: number) => void; unit: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="text-sm"><p>{label}</p><p className="text-xs text-muted">{hint}</p></div>
      <span className="inline-flex items-center gap-2 text-sm">
        <Input aria-label={label} type="number" min={0} defaultValue={value} onBlur={(e) => Number(e.target.value) !== value && onSave(Number(e.target.value))} className="h-9 w-24" />
        {unit}
      </span>
    </div>
  );
}

function FollowUpSection() {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const s = ref.settings;
  const save = (patch: Partial<Settings>) => runAction(updateSettings(patch), "Setting saved", { reference: true });
  return (
    <Card>
      <CardHeader title="Follow-ups" subtitle="Follow-up reminders and other notifications are set in Settings → Notifications." />
      <div className="divide-y divide-line">
        <NumberSetting label="Overdue after" hint="Grace period after the due time before it counts as overdue" value={s.overdueAfterMinutes} unit="minutes" onSave={(n) => save({ overdueAfterMinutes: n })} />
        <NumberSetting label="First-contact target for new leads" hint="Used to highlight slow responses on dashboards and reports" value={s.newLeadFirstContactTargetMinutes} unit="minutes" onSave={(n) => save({ newLeadFirstContactTargetMinutes: n })} />
        <NumberSetting label="Note edit window" hint="Authors can edit their notes for this long. Earlier versions are always kept." value={s.noteEditWindowMinutes} unit="minutes" onSave={(n) => save({ noteEditWindowMinutes: n })} />
      </div>
    </Card>
  );
}

// ── Payments and handover (used from Phase 4) ────────────────────────────

function PaymentsSection() {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const s = ref.settings;
  const save = (patch: Partial<Settings>) => runAction(updateSettings(patch), "Setting saved", { reference: true });
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Support handover trigger" subtitle="When a paying customer moves to customer support. Only manager-confirmed payments count." />
        <fieldset className="space-y-2 p-4">
          <legend className="sr-only">Handover trigger</legend>
          {([["qualifying_deposit", "Manager-confirmed qualifying deposit", "Hand over once confirmed payments reach the minimum below."], ["full_payment", "Full payment confirmed", "Hand over only when the agreed total is fully confirmed."]] as const).map(([k, label, hint]) => (
            <label key={k} className={clsx("flex gap-3 rounded-lg border p-3 text-sm", s.handoverTrigger === k ? "border-navy-900 bg-navy-50" : "border-line")}>
              <input type="radio" name="trigger" className="mt-1 accent-navy-900" checked={s.handoverTrigger === k} onChange={() => save({ handoverTrigger: k })} />
              <span><b>{label}</b><span className="block text-muted">{hint}</span></span>
            </label>
          ))}
        </fieldset>
      </Card>
      <Card>
        <CardHeader title="Qualifying deposit per program" subtitle="A program set to “Not set” hands over only on full payment. Full payment always hands over." />
        <div className="divide-y divide-line">
          {ref.programs.map((p) => {
            const rule = s.depositRule[p.id] ?? null;
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="w-20 font-medium">{p.name}</span>
                <Select aria-label={`${p.name} deposit type`} value={rule?.kind ?? "none"} className="h-9 w-auto" onChange={(e) => save({ depositRule: { ...s.depositRule, [p.id]: e.target.value === "none" ? null : { kind: e.target.value as "amount" | "percent", value: rule?.value ?? 30 } } })}>
                  <option value="none">Not set</option>
                  <option value="percent">Percent of agreed total</option>
                  <option value="amount">Fixed amount (EGP)</option>
                </Select>
                {rule && <Input key={`${p.id}-${rule.kind}`} aria-label={`${p.name} deposit value`} type="number" min={1} defaultValue={rule.value} onBlur={(e) => Number(e.target.value) !== rule.value && save({ depositRule: { ...s.depositRule, [p.id]: { ...rule, value: Number(e.target.value) } } })} className="h-9 w-28" />}
                {rule && <span className="text-muted">{rule.kind === "percent" ? "%" : "EGP"}</span>}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
