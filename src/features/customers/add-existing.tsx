"use client";

import { Paperclip, Plus, Trash2, UserCheck } from "lucide-react";
import { useState } from "react";
import { Button, IconButton } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { Field, Input, Select } from "@/components/ui/form";
import { Dialog } from "@/components/ui/overlay";
import { useToast } from "@/components/ui/toast";
import { cairoParts, formatMoney, isValidPhone } from "@/domain/rules";
import { useRunAction } from "@/lib/run-action";
import { useWorkspace } from "@/lib/workspace";
import { addExistingCustomer, lookupContactByPhone, type PhoneMatch } from "@/server/existing-customer-actions";

type Method = "bank_transfer" | "instapay" | "mobile_wallet" | "cash" | "card" | "other";
type Kind = "deposit" | "installment" | "full";
interface PaymentRow { key: number; amount: string; paidOn: string; method: Method; kind: Kind; reference: string; receipt: { token: string; name: string } | null; uploading?: boolean }
interface DueRow { key: number; dueOn: string; amount: string }

const METHODS: [Method, string][] = [["instapay", "InstaPay"], ["bank_transfer", "Bank transfer"], ["mobile_wallet", "Mobile wallet"], ["cash", "Cash"], ["card", "Card"], ["other", "Other"]];
const num = (s: string) => (s.trim() === "" ? 0 : Number(s));
let seq = 0;

function Section({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-xl border border-line p-4">
      <legend className="px-1 text-sm font-semibold"><span className="mr-1.5 text-muted">{n}.</span>{title}</legend>
      {hint && <p className="-mt-1 mb-3 text-xs text-muted">{hint}</p>}
      {children}
    </fieldset>
  );
}

/** Add a customer who is already enrolled: details, enrollment, past payments, what is left, teacher (managers and support). */
export function AddExistingCustomerDialog({ onClose }: { onClose: () => void }) {
  const { ref, me, now, openInquiry } = useWorkspace();
  const runAction = useRunAction();
  const toast = useToast();
  const today = cairoParts(now).date;
  const isSupport = me.role === "support";

  const [phone, setPhone] = useState("");
  const [match, setMatch] = useState<PhoneMatch | null>(null);
  const [checked, setChecked] = useState("");
  const [c, setC] = useState({ name: "", contactType: "parent" as "student" | "parent" | "other", studentName: "" });
  const [e, setE] = useState({ programId: ref.programs[0]?.id ?? "", courseId: "", agreed: "", priceNote: "", enrolledOn: today, salesAgentId: "", supportOwnerId: isSupport ? me.id : "", status: "onboarding" as "onboarding" | "active" });
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [dues, setDues] = useState<DueRow[]>([]);
  const [t, setT] = useState({ teacherId: "", rateId: "", subject: "", hoursBefore: "" });
  const [busy, setBusy] = useState(false);

  const courses = ref.courses.filter((x) => x.programId === e.programId && x.active);
  const course = ref.courses.find((x) => x.id === e.courseId);
  const currency = course?.currency ?? "EGP";
  const agreed = num(e.agreed);
  const paidSum = payments.reduce((s, p) => s + num(p.amount), 0);
  const left = Math.max(agreed - paidSum, 0);
  const dueSum = dues.reduce((s, d) => s + num(d.amount), 0);
  const priceDiffers = !!course && course.price != null && agreed > 0 && Math.abs(agreed - course.price) > 0.005;
  const isPackage = !!course?.sessionsCount && !!course?.sessionHours;
  const teachers = ref.teachers.filter((x) => x.active && ref.teacherRates.some((r) => r.teacherId === x.id && !r.archived));
  const rates = ref.teacherRates.filter((r) => r.teacherId === t.teacherId && !r.archived);
  const sales = ref.profiles.filter((p) => (p.role === "sales" || p.role === "manager") && p.active);
  const support = ref.profiles.filter((p) => p.role === "support" && p.active);
  const attaching = !!match;

  const checkPhone = async () => {
    if (!isValidPhone(phone) || phone === checked) return;
    setChecked(phone);
    const r = await lookupContactByPhone(phone);
    setMatch(r.ok ? r.value : null);
  };
  const pickCourse = (id: string) => {
    const x = ref.courses.find((k) => k.id === id);
    setE({ ...e, courseId: id, agreed: x?.price != null ? String(x.price) : e.agreed });
  };
  const setPay = (key: number, patch: Partial<PaymentRow>) => setPayments((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const upload = async (key: number, file: File) => {
    setPay(key, { uploading: true });
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/receipts", { method: "POST", body });
      const json = (await res.json()) as { token?: string; name?: string; error?: string };
      if (!res.ok || !json.token) throw new Error(json.error ?? "Upload failed.");
      setPay(key, { receipt: { token: json.token, name: json.name ?? file.name }, uploading: false });
    } catch (err) {
      toast.error((err as Error).message);
      setPay(key, { uploading: false });
    }
  };

  const problems = [
    !isValidPhone(phone) && "Enter the customer's phone number.",
    !attaching && !c.name.trim() && "Enter the customer's name.",
    !e.courseId && "Choose the course.",
    !(agreed > 0) && "Enter the agreed total.",
    priceDiffers && !e.priceNote.trim() && "Add a reason for the different price.",
    payments.some((p) => !(num(p.amount) > 0) || !p.paidOn) && "Each payment needs an amount and a date.",
    paidSum > agreed + 0.005 && "The payments add up to more than the agreed total.",
    dues.some((d) => !(num(d.amount) > 0) || !d.dueOn) && "Each planned payment needs a date and an amount.",
    dueSum > left + 0.005 && "The planned payments add up to more than what is left.",
    !!t.teacherId && !t.rateId && "Choose the teacher's rate.",
    payments.some((p) => p.uploading) && "Wait for the receipt to finish uploading.",
  ].filter(Boolean) as string[];

  const save = async () => {
    setBusy(true);
    const r = await runAction(addExistingCustomer({
      contactId: attaching ? match!.contactId : undefined,
      name: attaching ? undefined : c.name.trim(), phone, contactType: attaching ? undefined : c.contactType,
      studentName: c.studentName.trim() || undefined, programId: e.programId, courseId: e.courseId, agreedTotal: agreed,
      priceNote: e.priceNote.trim() || undefined, enrolledOn: e.enrolledOn, salesAgentId: e.salesAgentId || undefined,
      supportOwnerId: e.supportOwnerId || undefined, status: e.status, packageHoursBefore: isPackage ? num(t.hoursBefore) : undefined,
      payments: payments.map((p) => ({ amount: num(p.amount), paidOn: p.paidOn, method: p.method, kind: p.kind, reference: p.reference.trim() || undefined, receiptToken: p.receipt?.token })),
      dues: dues.map((d) => ({ dueOn: d.dueOn, amount: num(d.amount) })),
      teacher: t.teacherId && t.rateId ? { teacherId: t.teacherId, rateId: t.rateId, subject: t.subject.trim() || undefined } : undefined,
    }), null);
    setBusy(false);
    if (r.ok) {
      const what = r.value.additional ? "Course added to the customer's record" : "Customer added";
      toast.success(r.value.pending > 0 ? `${what}. The past payments are waiting for a manager or the accountant to confirm.` : what);
      onClose();
      openInquiry(r.value.inquiryId);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Add existing customer" className="max-w-3xl"
      description="For a customer who is already enrolled: they go straight to Support, without the sales pipeline or new-lead alerts, and Reports do not count them as new sales."
      footer={<>
        {problems[0] && <span className="mr-auto text-xs text-muted" data-testid="add-existing-hint">{problems[0]}</span>}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || problems.length > 0} onClick={save}>{busy ? "Saving…" : "Add customer"}</Button>
      </>}>
      <div className="space-y-4">
        <Section n={1} title="Customer">
          <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
            <Field label="Phone" required hint="Checked first, so the same person is not entered twice.">
              {(p) => <Input inputMode="tel" value={phone} onChange={(ev) => { setPhone(ev.target.value); setMatch(null); }} onBlur={checkPhone} placeholder="e.g. 0100 123 4567" {...p} />}
            </Field>
            <Field label="Student name" hint="If the customer is a parent, the child's name.">{(p) => <Input value={c.studentName} maxLength={120} onChange={(ev) => setC({ ...c, studentName: ev.target.value })} {...p} />}</Field>
            {match && (
              <div className="rounded-lg border border-navy-900/20 bg-navy-50 p-3 text-sm sm:col-span-2" data-testid="phone-match">
                <p className="flex items-center gap-2 font-medium"><UserCheck size={16} aria-hidden /> Already in the CRM: {match.name}</p>
                <ul className="mt-1 text-xs text-muted">{match.inquiries.slice(0, 4).map((i) => <li key={i.inquiryId}>{i.program}{i.student ? ` · ${i.student}` : ""} · {i.stage}{i.course ? ` · ${i.course}` : ""}</li>)}</ul>
                <p className="mt-2 text-xs">The course is added to {match.name}&apos;s record, beside their other courses. If it is for a different child, enter that child&apos;s name: they get their own record. For a different person, use their own phone number.</p>
              </div>
            )}
            {!attaching && (
              <>
                <Field label="Customer name" required>{(p) => <Input value={c.name} maxLength={120} onChange={(ev) => setC({ ...c, name: ev.target.value })} {...p} />}</Field>
                <Field label="Who is the customer">
                  {(p) => <Select value={c.contactType} onChange={(ev) => setC({ ...c, contactType: ev.target.value as typeof c.contactType })} {...p}>
                    <option value="parent">Parent</option><option value="student">Student</option><option value="other">Other</option>
                  </Select>}
                </Field>
              </>
            )}
          </div>
        </Section>

        <Section n={2} title="Enrollment">
          <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
            <Field label="Program" required>
              {(p) => <Select value={e.programId} onChange={(ev) => setE({ ...e, programId: ev.target.value, courseId: "" })} {...p}>{ref.programs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
            </Field>
            <Field label="Course" required>
              {(p) => <Select value={e.courseId} onChange={(ev) => pickCourse(ev.target.value)} {...p}><option value="">Choose a course</option>{courses.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
            </Field>
            <Field label={`Agreed total (${currency})`} required hint={course?.price != null ? `Course price ${formatMoney(course.price, currency)}` : undefined}>
              {(p) => <Input inputMode="decimal" value={e.agreed} onChange={(ev) => setE({ ...e, agreed: ev.target.value })} {...p} />}
            </Field>
            <Field label="Enrolled on" required>{(p) => <Input type="date" value={e.enrolledOn} max={today} onChange={(ev) => setE({ ...e, enrolledOn: ev.target.value })} {...p} />}</Field>
            {priceDiffers && (
              <Field label="Reason for the different price" required className="sm:col-span-2">{(p) => <Input value={e.priceNote} maxLength={300} placeholder="e.g. Sibling discount" onChange={(ev) => setE({ ...e, priceNote: ev.target.value })} {...p} />}</Field>
            )}
            <Field label="Sales agent credited">
              {(p) => <Select value={e.salesAgentId} onChange={(ev) => setE({ ...e, salesAgentId: ev.target.value })} {...p}><option value="">Before the CRM (nobody)</option>{sales.map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}</Select>}
            </Field>
            <Field label="Support owner">
              {(p) => <Select value={e.supportOwnerId} onChange={(ev) => setE({ ...e, supportOwnerId: ev.target.value })} disabled={isSupport && support.length <= 1} {...p}>
                {!isSupport && <option value="">Nobody yet (waits in the queue)</option>}
                {support.map((x) => <option key={x.id} value={x.id}>{x.fullName}{x.id === me.id ? " (me)" : ""}</option>)}
              </Select>}
            </Field>
            <Field label="Support status">
              {(p) => <Select value={e.status} onChange={(ev) => setE({ ...e, status: ev.target.value as typeof e.status })} {...p}><option value="onboarding">Onboarding</option><option value="active">Active (onboarding finished)</option></Select>}
            </Field>
          </div>
        </Section>

        <Section n={3} title="Payments already received" hint={isSupport ? "Payments you enter go to a manager or the accountant to confirm, like any payment you record." : "Payments a manager enters here are confirmed straight away. A receipt is optional for past payments."}>
          <ul className="space-y-2" aria-label="Past payments">
            {payments.map((p, i) => (
              <li key={p.key} className="grid gap-2 rounded-lg bg-canvas p-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto] [&>*]:min-w-0" data-payment={i + 1}>
                <Input aria-label={`Payment ${i + 1} amount`} inputMode="decimal" placeholder={`Amount (${currency})`} value={p.amount} onChange={(ev) => setPay(p.key, { amount: ev.target.value })} />
                <Input aria-label={`Payment ${i + 1} date paid`} type="date" max={today} value={p.paidOn} onChange={(ev) => setPay(p.key, { paidOn: ev.target.value })} />
                <Select aria-label={`Payment ${i + 1} method`} value={p.method} onChange={(ev) => setPay(p.key, { method: ev.target.value as Method })}>{METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
                <Select aria-label={`Payment ${i + 1} type`} value={p.kind} onChange={(ev) => setPay(p.key, { kind: ev.target.value as Kind })}><option value="deposit">Deposit</option><option value="installment">Installment</option><option value="full">Full payment</option></Select>
                <IconButton label={`Remove payment ${i + 1}`} icon={<Trash2 size={14} />} onClick={() => setPayments((ps) => ps.filter((x) => x.key !== p.key))} />
                <Input aria-label={`Payment ${i + 1} reference`} className="sm:col-span-2" placeholder="Reference (optional)" value={p.reference} maxLength={100} onChange={(ev) => setPay(p.key, { reference: ev.target.value })} />
                <label className={clsx("flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line bg-white px-3 text-xs sm:col-span-3", p.uploading && "opacity-60")}>
                  <Paperclip size={13} aria-hidden /> {p.uploading ? "Uploading…" : p.receipt ? p.receipt.name : "Attach receipt (optional)"}
                  <input type="file" className="sr-only" aria-label={`Payment ${i + 1} receipt`} accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(ev) => ev.target.files?.[0] && upload(p.key, ev.target.files[0])} />
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setPayments((ps) => [...ps, { key: ++seq, amount: "", paidOn: e.enrolledOn, method: "instapay", kind: ps.length ? "installment" : "deposit", reference: "", receipt: null }])}>Add a payment</Button>
            {agreed > 0 && <span className="text-sm" data-testid="paid-summary">Paid {formatMoney(paidSum, currency)} of {formatMoney(agreed, currency)} · <b className="font-semibold">{formatMoney(left, currency)} left</b></span>}
          </div>
        </Section>

        <Section n={4} title="What is left" hint="The due dates and amounts, so overdue reminders work from day one. Leave empty if nothing is left or there is no plan yet.">
          <ul className="space-y-2" aria-label="Planned payments">
            {dues.map((d, i) => (
              <li key={d.key} className="grid grid-cols-[1fr_1fr_auto] gap-2 [&>*]:min-w-0">
                <Input aria-label={`Planned payment ${i + 1} due date`} type="date" value={d.dueOn} onChange={(ev) => setDues((ds) => ds.map((x) => (x.key === d.key ? { ...x, dueOn: ev.target.value } : x)))} />
                <Input aria-label={`Planned payment ${i + 1} amount`} inputMode="decimal" placeholder={`Amount (${currency})`} value={d.amount} onChange={(ev) => setDues((ds) => ds.map((x) => (x.key === d.key ? { ...x, amount: ev.target.value } : x)))} />
                <IconButton label={`Remove planned payment ${i + 1}`} icon={<Trash2 size={14} />} onClick={() => setDues((ds) => ds.filter((x) => x.key !== d.key))} />
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button size="sm" icon={<Plus size={14} />} disabled={left <= 0} onClick={() => setDues((ds) => [...ds, { key: ++seq, dueOn: "", amount: String(Math.max(left - ds.reduce((s, x) => s + num(x.amount), 0), 0) || "") }])}>Add a planned payment</Button>
            {dues.length > 0 && <span className="text-sm text-muted">Planned {formatMoney(dueSum, currency)} of {formatMoney(left, currency)} left</span>}
          </div>
        </Section>

        {(teachers.length > 0 || isPackage) && (
          <Section n={5} title="Teaching (optional)">
            <div className="grid gap-3 sm:grid-cols-3 [&>*]:min-w-0">
              {teachers.length > 0 && <Field label="Teacher">
                {(p) => <Select value={t.teacherId} onChange={(ev) => { const id = ev.target.value; setT({ ...t, teacherId: id, rateId: ref.teacherRates.find((r) => r.teacherId === id && !r.archived)?.id ?? "" }); }} {...p}>
                  <option value="">No teacher yet</option>{teachers.map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}
                </Select>}
              </Field>}
              {t.teacherId && <Field label="Rate">{(p) => <Select value={t.rateId} onChange={(ev) => setT({ ...t, rateId: ev.target.value })} {...p}>{rates.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}</Field>}
              {t.teacherId && <Field label="Subject (optional)">{(p) => <Input value={t.subject} maxLength={60} placeholder="e.g. Math" onChange={(ev) => setT({ ...t, subject: ev.target.value })} {...p} />}</Field>}
              {isPackage && (
                <Field label="Package hours already used" hint={`Of ${course!.sessionsCount! * course!.sessionHours!} h in this package.`}>
                  {(p) => <Input inputMode="decimal" value={t.hoursBefore} onChange={(ev) => setT({ ...t, hoursBefore: ev.target.value })} placeholder="0" {...p} />}
                </Field>
              )}
            </div>
          </Section>
        )}
      </div>
    </Dialog>
  );
}
