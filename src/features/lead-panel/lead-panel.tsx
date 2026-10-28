"use client";

import {
  AlertCircle,
  ArrowRightLeft,
  BookmarkCheck,
  GraduationCap,
  CalendarPlus,
  Check,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Phone,
  PhoneOff,
  StickyNote,
  Tags,
  Trash2,
  UserX,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DncBadge, Pill, ReturningBadge, StageBadge, TAG_COLORS, TagChip } from "@/components/ui/badges";
import { Button, IconButton } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { DiscardDialog } from "@/components/ui/confirm";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { EmptyState, Name, PhoneText, SkeletonRows } from "@/components/ui/misc";
import { Dialog, Drawer } from "@/components/ui/overlay";
import type { LeadDetail } from "@/domain/dto";
import { DeleteDialog } from "@/features/deleted/delete-dialog";
import { can } from "@/domain/permissions";
import { followUpTiming, formatCairo, formatRelative, needsNextAction, telUrl, whatsappUrl } from "@/domain/rules";
import type { ID, StageKey } from "@/domain/types";
import { hydrate, profileName } from "@/lib/lead-row";
import { useRunAction } from "@/lib/run-action";
import { useApi, useWorkspace } from "@/lib/workspace";
import { addNote, changeStage, completeFollowUp, logShortcut, markCustomerOpened, markLeadOpened, setDoNotContact, setNoFollowUpReason, setReserved } from "@/server/actions";
import { addSupportNote, setInquiryCourse } from "@/server/payment-actions";
import { priceText } from "@/lib/courses";
import type { LeadRow } from "@/lib/lead-row";
import { DetailsTab } from "./details-tab";
import { PaymentsTab } from "./payments-tab";
import { SupportTab } from "./support-tab";
import { DncDialog, FollowUpDialog, LostDialog, ReassignDialog, RecordOutcomeDialog, TagsDialog } from "./dialogs";
import { Timeline } from "./timeline";

type Tab = "activity" | "details" | "payments" | "support";
type Modal = null | "followup" | "outcome" | "lost" | "tags" | "dnc" | "reassign" | "noFollowUp" | "reserve";

/** Mounted once by the app layout; opens whenever a record is selected anywhere. */
export function LeadPanelHost() {
  const { openInquiryId, openInquiry } = useWorkspace();
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(false);
  const close = () => (dirty ? setAsking(true) : openInquiry(null));
  return (
    <Drawer open={!!openInquiryId} onClose={close} label="Customer details">
      {openInquiryId && <LeadPanel key={openInquiryId} inquiryId={openInquiryId} onClose={close} onDirtyChange={setDirty} />}
      {asking && (
        <DiscardDialog
          open
          onKeep={() => setAsking(false)}
          onDiscard={() => {
            setAsking(false);
            setDirty(false);
            openInquiry(null);
          }}
        />
      )}
    </Drawer>
  );
}

function LeadPanel({ inquiryId, onClose, onDirtyChange }: { inquiryId: ID; onClose: () => void; onDirtyChange: (d: boolean) => void }) {
  const { me, ref, now, openInquiry } = useWorkspace();
  const runAction = useRunAction();
  const { data, error, loading, reload } = useApi<LeadDetail>(`/api/leads/${inquiryId}`);
  // Support staff open a customer on the Support tab; everyone else on Activity.
  const [tab, setTab] = useState<Tab>(me.role === "support" ? "support" : "activity");
  const [modal, setModal] = useState<Modal>(null);
  const [shortcut, setShortcut] = useState<"call" | "whatsapp" | undefined>();
  const [note, setNote] = useState("");
  const [detailsDirty, setDetailsDirty] = useState(false);
  const [menu, setMenu] = useState(false);
  const [deleting, setDeleting] = useState<"lead" | "customer" | null>(null);
  const [busy, setBusy] = useState(false);
  // Phase 1: which course the Support tab shows when the customer has several handed-over enrollments.
  const [courseSel, setCourseSel] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => onDirtyChange(note.trim().length > 0 || detailsDirty), [note, detailsDirty, onDirtyChange]);

  // The owner opening the record clears its yellow "New" highlight (once; others opening it change nothing).
  const markedRef = useRef(false);
  useEffect(() => {
    if (!data || markedRef.current) return;
    const q = data.row.inquiry;
    const salesOwnerFirstOpen = me.role === "sales" && q.salesOwnerId === me.id && !q.ownerOpenedAt;
    const supportOwnerFirstOpen = me.role === "support" && data.courses.some((b) => b.onboarding?.supportOwnerId === me.id && !b.onboarding.supportOpenedAt);
    if (!salesOwnerFirstOpen && !supportOwnerFirstOpen) return;
    markedRef.current = true;
    void runAction(salesOwnerFirstOpen ? markLeadOpened(q.id) : markCustomerOpened(q.id), null, { quiet: true });
  }, [data, me.id, me.role, runAction]);

  const row = useMemo(() => (data ? hydrate(data.row, ref) : null), [data, ref]);

  if (!data && loading) {
    return (
      <div className="p-5">
        <div className="mb-4 flex justify-end"><IconButton label="Close panel" icon={<X size={20} />} onClick={onClose} /></div>
        <SkeletonRows rows={6} />
      </div>
    );
  }
  if (!row || !data) {
    return (
      <div className="p-6">
        <IconButton label="Close panel" icon={<X size={20} />} onClick={onClose} />
        <EmptyState icon={<AlertCircle size={20} />} title="You do not have access to this record">
          {error ?? "It may belong to another agent. Ask a manager if you need it."}
        </EmptyState>
      </div>
    );
  }

  const q = row.inquiry;
  const ownsSales = me.role === "manager" || (me.role === "sales" && q.salesOwnerId === me.id);
  // Phase 1: each enrollment has its own handover; support owns the customer when they own any of them.
  const handed = data.courses.filter((b) => b.onboarding);
  const selected = handed.find((b) => b.enrollment.id === courseSel)
    ?? handed.find((b) => b.onboarding?.supportOwnerId === me.id) ?? handed[0];
  const ob = selected?.onboarding;
  const supportOwner = me.role === "support" && handed.some((b) => b.onboarding?.supportOwnerId === me.id);
  const supportView: LeadDetail = selected
    ? { ...data, enrollment: selected.enrollment, payments: selected.payments, totals: selected.totals, dues: selected.dues, teachers: selected.teachers,
        sessions: selected.sessions, onboarding: selected.onboarding, supportFollowUps: selected.supportFollowUps }
    : data;
  const canNote = ownsSales || supportOwner;
  const tabs: Tab[] = ob ? ["activity", "details", "payments", "support"] : ["activity", "details", "payments"];
  const shown: Tab = tabs.includes(tab) ? tab : "activity";
  const dnc = row.contact.doNotContact;
  const nextFu = row.nextFollowUp;
  const missingNext = needsNextAction(q, ref.stages, data.followUps);
  const accent = row.primaryTag ? TAG_COLORS[row.primaryTag.color].dot : "transparent";

  const doChangeStage = async (key: StageKey, lostReason?: string) => {
    const r = await runAction(changeStage(q.id, key, q.version, lostReason), `Stage changed to ${ref.stages.find((s) => s.systemKey === key)?.label}`);
    if (r.ok) setModal(null);
    else reload();
  };

  const doAddNote = async () => {
    if (!note.trim()) return;
    setBusy(true);
    const r = await runAction(ownsSales || !ob ? addNote(q.id, note) : addSupportNote(ob.id, note), "Note added");
    setBusy(false);
    if (r.ok) setNote("");
  };

  const openShortcut = (channel: "call" | "whatsapp") => {
    void logShortcut(q.id, channel);
    setShortcut(channel);
    setTimeout(() => setModal("outcome"), 400);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-line" style={{ boxShadow: `inset 4px 0 0 ${accent}` }}>
        <div className="flex items-start gap-3 px-5 pb-3 pt-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold leading-tight"><Name>{row.contact.name}</Name></h2>
              {dnc && <DncBadge />}
              {q.reserved && <Pill className="bg-navy-100 text-navy-800" icon={<BookmarkCheck size={12} aria-hidden />}>Reserved (not paid)</Pill>}
              {data.earlier.length > 0 && <ReturningBadge />}
            </div>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-muted">
              {q.studentName && <span>Student: <Name className="text-ink">{q.studentName}</Name> ·</span>}
              <span className="capitalize">{row.contact.contactType}</span>·<PhoneText value={row.contact.phoneNormalized} className="text-ink" />
            </p>
          </div>
          <IconButton label="Close panel" icon={<X size={20} />} onClick={onClose} />
        </div>

        <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
          <Pill className="bg-navy-900 text-white">{row.program.code}</Pill>
          {ownsSales ? (
            <label className="inline-flex items-center gap-1.5">
              <span className="sr-only">Stage</span>
              <Select
                value={row.stage.systemKey}
                onChange={(e) => {
                  const k = e.target.value as StageKey;
                  if (k === "lost") setModal("lost");
                  else void doChangeStage(k);
                }}
                className="h-8 w-auto py-0 text-[13px] font-medium"
              >
                {ref.stages.map((s) => (
                  <option key={s.id} value={s.systemKey} disabled={!s.agentSelectable && me.role !== "manager" && s.id !== q.stageId}>
                    {s.label}{!s.agentSelectable ? " (set by payment)" : ""}
                  </option>
                ))}
              </Select>
            </label>
          ) : (
            <StageBadge stage={row.stage} />
          )}
          <CourseControl row={row} editable={ownsSales && !data.enrollment} />
          {row.tags.map((t) => <TagChip key={t.id} tag={t} primary={t.id === q.primaryTagId} />)}
          {ownsSales && (
            <button onClick={() => setModal("tags")} className="inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-line px-2 text-xs text-muted hover:bg-navy-50 hover:text-ink">
              <Tags size={12} aria-hidden /> {row.tags.length ? "Edit tags" : "Add tags"}
            </button>
          )}
        </div>

        {data.earlier.length > 0 && (
          <section aria-label="Earlier leads" className="mx-5 mb-3 rounded-xl border border-info/20 bg-info-bg/60 px-3 py-2 text-sm">
            <p className="text-xs font-semibold text-info">Returning customer · {data.earlier.length} earlier lead{data.earlier.length === 1 ? "" : "s"}</p>
            <ul className="mt-1 space-y-0.5">
              {data.earlier.slice(0, 5).map((e) => {
                const text = `${e.programCode} · ${formatCairo(e.createdAt, "date")} · ${e.ownerName ?? "Unassigned"} · ${e.stageLabel}`;
                return (
                  <li key={e.inquiryId} className="text-xs text-ink">
                    {e.visible ? (
                      <button className="text-left underline decoration-info/40 underline-offset-2 hover:text-info" onClick={() => openInquiry(e.inquiryId)}>{text}</button>
                    ) : (
                      text
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <div className="mx-5 mb-3 grid gap-2 rounded-xl bg-canvas p-3 text-sm sm:grid-cols-[auto_1fr]">
          <div className="sm:border-r sm:border-line sm:pr-4">
            <p className="text-xs text-muted">Sales owner</p>
            <p className={clsx("font-medium", !q.salesOwnerId && "text-orange-ink")}>{profileName(ref, q.salesOwnerId)}</p>
            {row.outcome && <p className="text-xs text-muted">Last: {row.outcome.label}</p>}
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted">Next action</p>
            {nextFu ? (
              <div className="flex flex-wrap items-center gap-x-2">
                <p dir="auto" className="font-medium">{nextFu.note}</p>
                <span className={clsx("text-xs font-medium", followUpTiming(nextFu, now) === "overdue" ? "text-bad" : "text-muted")}>
                  {followUpTiming(nextFu, now) === "overdue" ? "Overdue · " : ""}{formatCairo(nextFu.dueAt)} ({formatRelative(nextFu.dueAt, now)})
                </span>
                {ownsSales && (
                  <button className="inline-flex items-center gap-1 text-xs font-medium text-navy-700 hover:underline" onClick={() => runAction(completeFollowUp(nextFu.id), "Follow-up completed")}>
                    <Check size={12} aria-hidden /> Mark done
                  </button>
                )}
              </div>
            ) : q.noFollowUpReason ? (
              <p className="text-muted">No follow-up needed: {q.noFollowUpReason}</p>
            ) : missingNext ? (
              <p className="flex items-center gap-1.5 font-medium text-orange-ink"><AlertCircle size={14} aria-hidden /> No next action set</p>
            ) : (
              <p className="text-muted">Closed · no follow-up needed</p>
            )}
            {missingNext && ownsSales && (
              <button className="mt-0.5 text-xs text-muted underline decoration-dotted" onClick={() => setModal("noFollowUp")}>Record why no follow-up is needed</button>
            )}
          </div>
        </div>

        {ownsSales && (
          <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
            {dnc ? (
              <p className="flex items-center gap-1.5 text-sm text-bad"><PhoneOff size={15} aria-hidden /> Outreach is disabled: {row.contact.doNotContactReason}</p>
            ) : (
              <>
                <a href={telUrl(row.contact.phoneNormalized)} onClick={() => openShortcut("call")} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-navy-900 px-3 text-sm font-semibold text-white hover:bg-navy-800">
                  <Phone size={15} aria-hidden /> Call
                </a>
                <a href={whatsappUrl(row.contact.phoneNormalized)} target="_blank" rel="noreferrer" onClick={() => openShortcut("whatsapp")} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#1f7a4d] px-3 text-sm font-semibold text-white hover:bg-[#186640]">
                  <MessageCircle size={15} aria-hidden /> WhatsApp
                </a>
                <Button size="sm" className="h-9" icon={<Pencil size={14} />} onClick={() => setModal("outcome")}>Record outcome</Button>
              </>
            )}
            <Button size="sm" className="h-9" icon={<StickyNote size={14} />} onClick={() => { setTab("activity"); setTimeout(() => noteRef.current?.focus(), 50); }}>Add note</Button>
            <Button size="sm" className="h-9" icon={<CalendarPlus size={14} />} onClick={() => setModal("followup")} disabled={dnc}>Set follow-up</Button>
            <div className="relative ml-auto">
              <IconButton label="More actions" icon={<MoreHorizontal size={18} />} aria-expanded={menu} onClick={() => setMenu((m) => !m)} />
              {menu && (
                <div className="absolute right-0 z-20 mt-1 w-56 rounded-xl border border-line bg-white p-1 shadow-[var(--shadow-panel)]" onClick={() => setMenu(false)}>
                  <MenuItem icon={<BookmarkCheck size={15} />} onClick={() => (q.reserved ? runAction(setReserved(q.id, false), "Reservation removed") : setModal("reserve"))}>
                    {q.reserved ? "Remove reservation" : "Mark as reserved"}
                  </MenuItem>
                  {can(me.role, "inquiry.reassign") && <MenuItem icon={<ArrowRightLeft size={15} />} onClick={() => setModal("reassign")}>{q.salesOwnerId ? "Reassign owner" : "Assign owner"}</MenuItem>}
                  {dnc ? (
                    can(me.role, "doNotContact.remove") && <MenuItem icon={<Phone size={15} />} onClick={() => runAction(setDoNotContact(q.id, false), "Do Not Contact removed")}>Remove Do Not Contact</MenuItem>
                  ) : (
                    <MenuItem icon={<PhoneOff size={15} />} danger onClick={() => setModal("dnc")}>Mark Do Not Contact</MenuItem>
                  )}
                  {me.role === "manager" && (
                    <>
                      <MenuItem icon={<Trash2 size={15} />} danger onClick={() => setDeleting("lead")}>Delete this lead</MenuItem>
                      <MenuItem icon={<UserX size={15} />} danger onClick={() => setDeleting("customer")}>Delete the person and all their leads</MenuItem>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <div role="tablist" aria-label="Record sections" className="flex gap-1 overflow-x-auto px-3">
          {tabs.map((t) => (
            <button key={t} role="tab" aria-selected={shown === t} onClick={() => setTab(t)} className={clsx("whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium capitalize", shown === t ? "border-orange-500 text-navy-900" : "border-transparent text-muted hover:text-ink")}>
              {t}{t === "support" && ob?.flaggedForReview ? " ⚠" : ""}
            </button>
          ))}
        </div>
      </header>

      <div role="tabpanel" className="scrollbar-thin flex-1 overflow-y-auto px-5 py-5">
        {shown === "activity" && (
          <div className="space-y-5">
            {canNote && (
              <div className="rounded-xl border border-line p-3">
                <label htmlFor="note" className="sr-only">Add a note</label>
                <Textarea
                  id="note"
                  ref={noteRef}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Add a note (Arabic or English)"
                  className="min-h-[72px] border-0 px-1 focus:ring-0"
                  onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void doAddNote()}
                />
                <div className="flex items-center justify-between gap-2 pt-2">
                  <span className="hidden text-xs text-muted sm:inline">Ctrl + Enter to save. Earlier notes are never overwritten.</span>
                  <Button size="sm" variant="navy" onClick={doAddNote} disabled={!note.trim() || busy}>Add note</Button>
                </div>
              </div>
            )}
            <Timeline activities={data.activities} />
          </div>
        )}
        {shown === "details" && <DetailsTab row={row} values={data.fieldValues} onDirtyChange={setDetailsDirty} onReload={reload} />}
        {shown === "payments" && (
          <PaymentsTab detail={data} row={row} canWork={ownsSales} canAdd={ownsSales || supportOwner}
            canPay={ownsSales || supportOwner || me.role === "accountant"} canPlan={me.role === "manager" || supportOwner} />
        )}
        {shown === "support" && ob && (
          <>
            {handed.length > 1 && (
              <Field label="Course" className="mb-4">
                {(p) => (
                  <Select value={selected?.enrollment.id} onChange={(e) => setCourseSel(e.target.value)} {...p}>
                    {handed.map((b) => <option key={b.enrollment.id} value={b.enrollment.id}>{ref.courses.find((c) => c.id === b.enrollment.courseId)?.name ?? "Course"} · {profileName(ref, b.onboarding?.supportOwnerId ?? null)}</option>)}
                  </Select>
                )}
              </Field>
            )}
            <SupportTab key={selected?.enrollment.id} detail={supportView} />
          </>
        )}
      </div>

      {deleting && <DeleteDialog kind={deleting} id={deleting === "lead" ? q.id : row.contact.id} onClose={() => setDeleting(null)} onDeleted={onClose} />}
      {modal === "followup" && <FollowUpDialog onClose={() => setModal(null)} inquiryId={q.id} />}
      {modal === "outcome" && <RecordOutcomeDialog onClose={() => { setModal(null); setShortcut(undefined); }} inquiryId={q.id} channel={shortcut} />}
      {modal === "lost" && <LostDialog onClose={() => setModal(null)} onConfirm={(r) => doChangeStage("lost", r)} />}
      {modal === "tags" && <TagsDialog onClose={() => setModal(null)} inquiry={q} />}
      {modal === "dnc" && <DncDialog onClose={() => setModal(null)} inquiryId={q.id} />}
      {modal === "reassign" && <ReassignDialog onClose={() => setModal(null)} inquiryId={q.id} currentOwner={q.salesOwnerId} />}
      {modal === "noFollowUp" && <ReasonDialog title="No follow-up needed" label="Why is no follow-up needed?" onClose={() => setModal(null)} onSave={(r) => runAction(setNoFollowUpReason(q.id, r), "Reason saved")} />}
      {modal === "reserve" && <ReasonDialog title="Mark as reserved" description="A reservation holds a seat. It is not a payment and does not hand the customer to support." label="Note (optional)" optional onClose={() => setModal(null)} onSave={(r) => runAction(setReserved(q.id, true, r), "Marked as reserved")} />}
    </div>
  );
}

/** The lead's course of interest: a picker for the owner, a label for everyone else. Fixed once enrolled. */
function CourseControl({ row, editable }: { row: LeadRow; editable: boolean }) {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const options = ref.courses.filter((c) => c.programId === row.program.id && (c.active || c.id === row.inquiry.courseId));
  if (!editable) {
    return row.course
      ? <Pill className="bg-navy-50 text-navy-800" icon={<GraduationCap size={12} aria-hidden />}><span title={priceText(row.course)}>{row.course.name}</span></Pill>
      : null;
  }
  return (
    <label className="inline-flex items-center gap-1.5">
      <span className="sr-only">Course</span>
      <Select value={row.inquiry.courseId ?? ""} className="h-8 w-auto max-w-[340px] py-0 text-[13px]"
        onChange={(e) => runAction(setInquiryCourse(row.inquiry.id, e.target.value || null, row.inquiry.version), e.target.value ? "Course saved" : "Course cleared")}>
        <option value="">No course yet</option>
        {options.map((c) => <option key={c.id} value={c.id}>{c.name} ({priceText(c)})</option>)}
      </Select>
    </label>
  );
}

function MenuItem({ children, icon, onClick, danger }: { children: React.ReactNode; icon: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={clsx("flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-navy-50", danger && "text-bad")}>
      {icon}
      {children}
    </button>
  );
}

function ReasonDialog({ title, description, label, optional, onClose, onSave }: { title: string; description?: string; label: string; optional?: boolean; onClose: () => void; onSave: (r: string) => Promise<{ ok: boolean }> }) {
  const [v, setV] = useState("");
  return (
    <Dialog open onClose={onClose} title={title} description={description} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => (await onSave(v)).ok && onClose()}>Save</Button></>}>
      <Field label={label} required={!optional}>{(p) => <Input value={v} onChange={(e) => setV(e.target.value)} {...p} />}</Field>
    </Dialog>
  );
}
