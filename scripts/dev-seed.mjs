/**
 * Synthetic data for local development and browser tests. Every person and
 * phone number is fictional. Records are created through the real database
 * functions (as the right staff member), then timestamps are spread over the
 * past days so dashboards look like a working week.
 */

const STAFF = [
  ["Hana Farouk", "hana@example.test", "manager"],
  ["Nour Hassan", "nour@example.test", "sales"],
  ["Youssef Adel", "youssef@example.test", "sales"],
  ["Mariam Samir", "mariam@example.test", "sales"],
  ["Laila Ibrahim", "laila@example.test", "support"],
  ["Karim Fawzy", "karim@example.test", "accountant"],
];

// [name, phone, program, owner, stage, outcome, hoursAgo, follow-up [hoursFromNow, note], extras]
const LEADS = [
  ["Youssef Ahmed", "0100 555 0101", "SAT", "nour", "new", null, 0.4],
  ["مريم خالد", "0101 555 0102", "IELTS", "nour", "new", null, 1.2],
  ["Hoda Salem", "0102 555 0103", "SAT", "nour", "awaiting_payment", "reached", 96, [3, "Confirm deposit transfer arrived"], { type: "parent", student: "Ali", tags: ["High Interest"], primary: "High Interest", notes: ["Spoke with mother. Ali is in Grade 12, wants the December intensive.", "الأم موافقة على الدفعة الأولى، هتحول النهارده أو بكرة"], grade: "Grade 12" }],
  ["Hoda Salem", "0102 555 0103", "SAT", "nour", "qualified", "reached", 95, [72, "Ask about March course for Salma"], { type: "parent", student: "Salma", tags: ["Future Intake"], primary: "Future Intake", grade: "Grade 10" }],
  ["سلمى عبد الرحمن", "0111 555 0105", "SAT", "nour", "contacting", "busy", 30, [1.5, "Call back after school hours"], { tags: ["Requested Callback"], primary: "Requested Callback" }],
  ["Omar Farid", "0112 555 0106", "SAT", "nour", "contacting", "no_answer", 50, [-20, "Try WhatsApp then call"]],
  ["Nadine Wahba", "0114 555 0107", "IELTS", "nour", "qualified", "reached", 70, [5, "Send IELTS Academic schedule"], { ielts: "Academic" }],
  ["أحمد سمير", "0115 555 0108", "SAT", "nour", "contacting", "requested_callback", 8, [0.6, "Requested call at 6 pm"], { tags: ["Requested Callback"], primary: "Requested Callback" }],
  ["Laila Hamdy", "0120 555 0109", "SAT", "nour", "lost", "reached", 300, null, { lost: "Chose another provider" }],
  ["Adam Wael", "0115 555 0122", "SAT", "nour", "contacting", "no_answer", 100, [-50, "Try one more time"]],
  ["ريم أسامة", "0127 555 0126", "SAT", "nour", "contacting", "reached", 40, [27, "Send course comparison"]],
  ["Sara Nasser", "+971 50 555 0130", "IELTS", "nour", "qualified", "reached", 36, [8, "Confirm cohort start date (lives in Dubai)"], { tags: ["High Interest"], ielts: "General Training" }],
  ["Tarek Nabil", "0121 555 0110", "SAT", "youssef", "qualified", "reached", 55, [-4, "Manager to call about installment plan"], { type: "parent", student: "Hamza", tags: ["Needs Manager"], primary: "Needs Manager" }],
  ["Jana Ezzat", "0128 555 0113", "SAT", "youssef", "awaiting_payment", "reached", 110, [20, "Follow up on corrected transfer reference"], { tags: ["High Interest"], primary: "High Interest", reserved: "Seat held until Friday per manager" }],
  ["Rana Adly", "0101 555 0115", "SAT", "youssef", "contacting", "no_answer", 28, [6, "Call again"]],
  ["Hassan Gamal", "0102 555 0116", "SAT", "youssef", "new", null, 2],
  ["Khaled Fouad", "0121 555 0124", "SAT", "youssef", "contacting", "requested_callback", 5, [2, "Father asked for a call this evening"], { type: "parent", student: "Youssef", tags: ["Requested Callback"] }],
  ["Ziad Magdy", "0109 555 0118", "SAT", "youssef", "invalid", "wrong_number", 150],
  ["يوسف حسن", "0127 555 0112", "IELTS", "mariam", "new", null, 3],
  ["نور الهدى علي", "0106 555 0117", "IELTS", "mariam", "contacting", "busy", 12, [-1, "Retry after work hours"]],
  ["Habiba Osama", "0120 555 0123", "IELTS", "mariam", "qualified", "reached", 45, null, { ielts: "General Training", noFollowUp: "Waiting for her IELTS mock result" }],
  ["Aya Kamal", "0114 555 0121", "IELTS", "mariam", "contacting", "reached", 400, null, { dnc: "Asked not to receive calls or messages" }],
  ["Mazen Ali", "0102 555 0131", "IELTS", null, "new", null, 0.8],
  ["هنا محمود", "0106 555 0132", "SAT", null, "new", null, 0.5],
  ["Yassin Reda", "0109 555 0133", "IELTS", null, "new", null, 0.1],
];

function normalize(raw) {
  let s = raw.trim();
  const plus = s.startsWith("+");
  s = s.replace(/[^\d]/g, "");
  if (plus) return "+" + s;
  if (/^01\d{9}$/.test(s)) return "+20" + s.slice(1);
  return s;
}

export async function seedDev(admin) {
  const q = (sql, params = []) => admin.query(sql, params).then((r) => r.rows);
  const asUser = async (uid, sql, params = []) => {
    await admin.query("begin");
    try {
      await admin.query("set local role authenticated");
      await admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
      const r = await admin.query(sql, params);
      await admin.query("commit");
      return r.rows;
    } catch (e) {
      await admin.query("rollback");
      throw e;
    }
  };

  const ids = {};
  for (const [name, email, role] of STAFF) {
    const [u] = await q("insert into auth.users (email) values ($1) returning id", [email]);
    await q("insert into public.profiles (id, full_name, email, role, rotation_order) values ($1, $2, $3, $4, $5)", [u.id, name, email, role, Object.keys(ids).length]);
    ids[email.split("@")[0]] = u.id;
  }
  const manager = ids.hana;

  const programs = Object.fromEntries((await q("select code, id from public.programs")).map((r) => [r.code, r.id]));
  const outcomes = Object.fromEntries((await q("select system_key, id from public.contact_outcomes")).map((r) => [r.system_key, r.id]));
  const tags = Object.fromEntries((await q("select name, id from public.tags")).map((r) => [r.name, r.id]));
  const fields = Object.fromEntries((await q("select key, id from public.field_definitions")).map((r) => [r.key, r.id]));
  const option = async (key, label) => (await q("select o.id from public.field_options o join public.field_definitions f on f.id = o.field_id where f.key = $1 and o.label = $2", [key, label]))[0]?.id;

  // Course catalog (fictional prices for local review only).
  const types = Object.fromEntries((await q("select name, id from public.course_types")).map((r) => [r.name, r.id]));
  const course = async (c) => (await asUser(manager, "select public.save_course($1) as id", [c]))[0].id;
  const courses = {
    satIntensive: await course({ program_id: programs.SAT, course_type_id: types["Intensive"], name: "SAT · December 2026 Intensive", price: 12000, delivery: "online",
      duration_weeks: 4, sessions_count: 16, session_hours: 2, schedule: "Sun, Tue, Thu 7–9 pm", start_date: "2026-11-23", end_date: "2026-12-20", capacity: 25,
      description: "Four-week Digital SAT intensive before the December test: Math and Reading & Writing, two full mocks." }),
    satFull: await course({ program_id: programs.SAT, course_type_id: types["Group course"], name: "SAT · March 2027 Full Course", price: 15000, delivery: "hybrid",
      duration_weeks: 12, sessions_count: 24, session_hours: 2, schedule: "Sat & Mon 5–7 pm", start_date: "2027-01-02", end_date: "2027-03-27", capacity: 30,
      description: "Complete Digital SAT preparation from diagnostic to test day, with weekly homework review." }),
    satPrivate: await course({ program_id: programs.SAT, course_type_id: types["Private 1:1"], name: "SAT · Private 1:1 (10 sessions)", price: 9500, delivery: "online",
      sessions_count: 10, session_hours: 1.5, schedule: "Flexible", description: "One-to-one sessions focused on the student's weakest areas." }),
    satMocks: await course({ program_id: programs.SAT, course_type_id: types["Mock exams"], name: "SAT · Mock exam pack (4 tests)", price: 1800, delivery: "online",
      sessions_count: 4, description: "Four timed Digital SAT mocks with score reports and review." }),
    ieltsAcademic: await course({ program_id: programs.IELTS, course_type_id: types["Group course"], name: "IELTS · November 2026 Academic", price: 8500, delivery: "online",
      duration_weeks: 6, sessions_count: 18, session_hours: 2, schedule: "Sun, Tue, Thu 8–10 pm", start_date: "2026-11-03", end_date: "2026-12-13", capacity: 20,
      description: "All four skills for IELTS Academic, with weekly writing feedback." }),
    ieltsGeneral: await course({ program_id: programs.IELTS, course_type_id: types["Group course"], name: "IELTS · General Training (evening)", price: 7500, delivery: "online",
      duration_weeks: 6, sessions_count: 12, session_hours: 2, schedule: "Mon & Wed 8–10 pm", start_date: "2026-11-09", capacity: 20 }),
    ieltsSpeaking: await course({ program_id: programs.IELTS, course_type_id: types["Private 1:1"], name: "IELTS · Speaking coaching 1:1", price: 4000, delivery: "online",
      sessions_count: 6, session_hours: 1, schedule: "Flexible", description: "Six speaking sessions with band feedback." }),
  };

  for (const [name, phone, program, ownerKey, stage, outcome, hoursAgo, follow, x = {}] of LEADS) {
    const owner = ownerKey ? ids[ownerKey] : null;
    const actor = owner ?? manager;
    const body = { name, phone, phone_normalized: normalize(phone), program_id: programs[program], contact_type: x.type ?? "student", student_name: x.student ?? null, custom: {} };
    if (!owner) body.assign_to = null;
    const [{ r }] = await asUser(actor, "select public.create_inquiry($1) as r", [body]);
    const id = r.inquiry_id;
    const values = {};
    if (x.grade) values[fields.grade] = await option("grade", x.grade);
    if (x.ielts) values[fields.ielts_type] = await option("ielts_type", x.ielts);
    if (Object.keys(values).length) await asUser(actor, "select public.set_field_values($1, $2, null)", [id, values]);
    if (outcome) await asUser(actor, "select public.record_contact_attempt($1, $2, null)", [id, outcomes[outcome]]);
    for (const n of x.notes ?? []) await asUser(actor, "select public.add_note($1, $2)", [id, n]);
    if (stage !== "new" && stage !== "contacting") {
      await asUser(actor, "select public.change_stage($1, $2::public.stage_key, null, $3)", [id, stage, x.lost ?? null]);
    }
    if (x.tags) await asUser(actor, "select public.set_tags($1, $2::uuid[], $3)", [id, x.tags.map((t) => tags[t]), x.primary ? tags[x.primary] : null]);
    if (follow) await asUser(actor, "select public.create_follow_up($1, now() + interval '1 hour', $2)", [id, follow[1]]);
    if (x.reserved) await asUser(actor, "select public.set_reserved($1, true, $2)", [id, x.reserved]);
    if (x.noFollowUp) await asUser(actor, "select public.set_no_follow_up_reason($1, $2)", [id, x.noFollowUp]);
    if (x.dnc) await asUser(actor, "select public.set_do_not_contact($1, true, $2)", [id, x.dnc]);

    // Spread history: the inquiry arrived `hoursAgo`, later events keep their order.
    await q(
      `update public.inquiries set
         created_at = now() - make_interval(secs => $2::numeric * 3600),
         assigned_at = case when assigned_at is not null then now() - make_interval(secs => $2::numeric * 3600 - 60) end,
         first_contact_attempt_at = case when first_contact_attempt_at is not null then now() - make_interval(secs => $2::numeric * 3600 * 0.9) end,
         last_contact_at = case when last_contact_at is not null then now() - make_interval(secs => least($2::numeric * 3600 * 0.5, $2::numeric * 3600 - 300)) end
       where id = $1`,
      [id, hoursAgo],
    );
    await q(
      `with ranked as (select id, row_number() over (order by created_at, id) as n, count(*) over () as total from public.activities where inquiry_id = $1)
       update public.activities a set created_at = now() - make_interval(secs => $2::numeric * 3600 * (1 - (r.n - 1)::numeric / greatest(r.total, 1)))
       from ranked r where a.id = r.id`,
      [id, hoursAgo],
    );
    if (follow) await q("update public.follow_ups set due_at = now() + make_interval(secs => $2::numeric * 3600), created_at = now() - interval '1 hour' where inquiry_id = $1", [id, follow[0]]);
  }
  // ── Payments and support (Phase 4), all fictional ──
  // Example qualifying deposit for local review only: 30% of the agreed total for both programs.
  await q("update public.app_settings set handover_trigger = 'qualifying_deposit', deposit_rule = $1", [{ [programs.SAT]: { kind: "percent", value: 30 }, [programs.IELTS]: { kind: "percent", value: 30 } }]);
  const inquiryOf = async (name, student = null) => (await q(
    "select i.id from public.inquiries i join public.contacts c on c.id = i.contact_id where c.name = $1 and coalesce(i.student_name, '') = coalesce($2, '') limit 1", [name, student]))[0].id;
  const enroll = async (user, inquiry, course, total, note = null) =>
    (await asUser(user, "select public.save_enrollment($1) as id", [{ inquiry_id: inquiry, course_id: course, agreed_total: total, price_note: note }]))[0].id;
  const receiptsDir = process.env.RECEIPTS_DIR ?? ".local/receipts";
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { randomUUID } = await import("node:crypto");
  const fakeReceipt = () => {
    // A tiny, valid one-page PDF that says it is a synthetic receipt.
    const id = randomUUID();
    mkdirSync(receiptsDir, { recursive: true });
    const text = "Synthetic receipt for local review - not a real payment";
    const stream = `BT /F1 14 Tf 40 760 Td (${text}) Tj ET`;
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [];
    objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}`;
    pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    writeFileSync(`${receiptsDir}/${id}.pdf`, pdf);
    return { path: `receipts/${id}.pdf`, name: "instapay-receipt.pdf", mime: "application/pdf", size: pdf.length };
  };
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const pay = async (user, enrollment, amount, method, reference, receipt = null) =>
    (await asUser(user, "select public.submit_payment($1) as id", [{ enrollment_id: enrollment, amount, paid_on: today, method, reference, receipt }]))[0].id;
  const decide = (payment, decision, reason = null) => asUser(manager, "select public.decide_payment($1, $2, $3)", [payment, decision, reason]);

  // Hoda Salem (Ali): enrolled in the December intensive, deposit submitted, waiting for a manager.
  const hodaAli = await inquiryOf("Hoda Salem", "Ali");
  const eHoda = await enroll(ids.nour, hodaAli, courses.satIntensive, 12000);
  await pay(ids.nour, eHoda, 3600, "instapay", "IPN-55501234", fakeReceipt());
  await asUser(ids.nour, "select public.set_inquiry_course($1, $2)", [await inquiryOf("Hoda Salem", "Salma"), courses.satFull]);

  // Jana Ezzat: 30% deposit confirmed → handed over, waiting in the support queue.
  const jana = await inquiryOf("Jana Ezzat");
  const eJana = await enroll(ids.youssef, jana, courses.satFull, 15000);
  await decide(await pay(ids.youssef, eJana, 4500, "bank_transfer", "CIB-TRX-889201", fakeReceipt()), "confirmed");
  // Her payment plan (set after the deposit): one installment already overdue, one next month.
  await q(`insert into public.payment_dues (enrollment_id, due_on, amount, note, created_by, created_at, due_soon_notified_at, overdue_notified_at)
           values ($1, (now() at time zone 'Africa/Cairo')::date - 3, 5000, 'Second installment', $2, now(), now(), now()),
                  ($1, (now() at time zone 'Africa/Cairo')::date + 27, 5500, 'Final installment', $2, now(), null, null)`, [eJana, manager]);

  // Sara Nasser: early-bird price, paid in full → handed over and being onboarded by Laila.
  const sara = await inquiryOf("Sara Nasser");
  const eSara = await enroll(ids.nour, sara, courses.ieltsAcademic, 8000, "Early-bird offer");
  await decide(await pay(ids.nour, eSara, 8000, "mobile_wallet", "VC-2026-77120", fakeReceipt()), "confirmed");
  const [onbSara] = await q("select o.id from public.onboardings o where o.enrollment_id = $1", [eSara]);
  await asUser(ids.laila, "select public.claim_onboarding($1)", [onbSara.id]);
  const items = await q("select template_item_id from public.onboarding_items where onboarding_id = $1 order by sort limit 2", [onbSara.id]);
  for (const it of items) await asUser(ids.laila, "select public.set_checklist_item($1, $2, true)", [onbSara.id, it.template_item_id]);
  await asUser(ids.laila, "select public.create_support_follow_up($1, now() + interval '2 days', 'Check she joined the first class')", [onbSara.id]);

  // Tarek Nabil (Hamza): private sessions, first transfer rejected by the manager.
  const tarek = await inquiryOf("Tarek Nabil", "Hamza");
  const eTarek = await enroll(ids.youssef, tarek, courses.satPrivate, 9500);
  await decide(await pay(ids.youssef, eTarek, 2000, "instapay", "IPN-00000000", fakeReceipt()), "rejected", "Reference not found in the bank statement");

  // Teachers and hourly rates; a group teacher for the SAT full course, a private teacher for Sara.
  const teacher = async (full_name, program_ids, rates) => {
    const [{ id }] = await asUser(manager, "select public.save_teacher($1) as id", [{ full_name, program_ids, phone: "+20 100 000 0000" }]);
    const ids2 = {};
    for (const [name, amount] of rates) ids2[name] = (await asUser(manager, "select public.add_teacher_rate($1) as id", [{ teacher_id: id, name, amount, currency: "EGP", valid_from: "2026-09-26" }]))[0].id;
    return { id, rates: ids2 };
  };
  const tSami = await teacher("Ahmed Sami", [programs.SAT], [["SAT private", 400], ["SAT group", 600]]);
  const tDina = await teacher("Dina Kamal", [programs.IELTS], [["IELTS private", 450]]);
  await asUser(manager, "select public.assign_teacher($1)", [{ teacher_id: tSami.id, rate_id: tSami.rates["SAT group"], course_id: courses.satFull, subject: "Math", started_on: "2026-10-01" }]);
  await asUser(manager, "select public.assign_teacher($1)", [{ teacher_id: tDina.id, rate_id: tDina.rates["IELTS private"], enrollment_id: eSara, started_on: "2026-10-15" }]);

  // Courses of interest on a few more leads.
  await asUser(ids.nour, "select public.set_inquiry_course($1, $2)", [await inquiryOf("Nadine Wahba"), courses.ieltsAcademic]);
  await asUser(ids.nour, "select public.set_inquiry_course($1, $2)", [await inquiryOf("Omar Farid"), courses.satIntensive]);
  await asUser(ids.youssef, "select public.set_inquiry_course($1, $2)", [await inquiryOf("Rana Adly"), courses.satMocks]);
  await asUser(ids.mariam, "select public.set_inquiry_course($1, $2)", [await inquiryOf("Habiba Osama"), courses.ieltsGeneral]);

  // Shifts (Cairo time). Week starts Sunday. Youssef's evening shift runs to midnight.
  const SUN_THU = [0, 1, 2, 3, 4];
  const shift = (user, weekday, start, end, progs) =>
    asUser(manager, "select public.save_shift($1)", [{ user_id: user, weekday, start, end, program_ids: progs }]);
  for (const d of SUN_THU) await shift(ids.nour, d, "09:00", "17:00", [programs.SAT, programs.IELTS]);
  for (const d of SUN_THU) await shift(ids.youssef, d, "16:00", "00:00", [programs.SAT]);
  for (const d of [6, 0, 1, 2, 3]) await shift(ids.mariam, d, "12:00", "20:00", [programs.IELTS]);
  await shift(ids.youssef, 5, "12:00", "20:00", [programs.SAT, programs.IELTS]); // Friday cover
  await shift(ids.mariam, 5, "14:00", "22:00", [programs.IELTS]);
  await asUser(manager, "select public.save_time_off($1, (now() at time zone 'Africa/Cairo')::date + 7, (now() at time zone 'Africa/Cairo')::date + 9, 'Family event')", [ids.mariam]);

  // Same rule as the live data when "New" highlighting started: leads someone already tried to
  // contact (or closed) count as opened; uncontacted open leads show as new.
  await q(`update public.inquiries i set owner_opened_at = coalesce(i.first_contact_attempt_at, i.assigned_at, i.created_at)
           where i.sales_owner_id is not null and (i.first_contact_attempt_at is not null
             or exists (select 1 from public.stages s where s.id = i.stage_id and s.is_closed))`);
  await q("update public.onboardings set support_opened_at = claimed_at where claimed_at is not null and support_opened_at is null");

  // Same as the live data when step 2 notifications started: no burst of alerts for what was
  // already there, and the seed's own "New lead" notifications are not kept (live had none).
  await q("update public.inquiries set unopened_alert_at = now() where sales_owner_id is not null and owner_opened_at is null and unopened_alert_at is null");
  await q("update public.follow_ups set reminded_at = now() where reminded_at is null and due_at <= now() + interval '15 minutes'");
  await q("update public.support_follow_ups set reminded_at = now() where reminded_at is null and due_at <= now() + interval '15 minutes'");
  await q("delete from public.notifications where kind = 'new_lead'");

  await q("update public.audit_log set created_at = now() - interval '2 days' where created_at > now() - interval '1 minute'");
  return ids;
}
