"""
Phase 3 browser test: Google Sheets one-click connection (simulated Google),
automatic 2-minute sync through the scheduler route, Needs Review, shifts and
round-robin distribution, failure handling (revoked access, renamed column).

Runs against the production build and a freshly seeded local database:
  GOOGLE_MODE=fake CRON_SECRET=... AUTH_MODE=local DATABASE_URL=... npm start
  python3 tests/e2e/phase3_e2e.py [screenshot_dir]
Synthetic data only.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
import hydration  # noqa: F401  (waits for the page to be interactive after each load)

BASE = "http://localhost:3000"
ROOT = Path(__file__).parents[2]
FAKE = Path(os.environ.get("FAKE_GOOGLE_FILE", ROOT / ".local/fake-google.json"))
CRON_SECRET = os.environ.get("CRON_SECRET", "local-cron-secret-for-tests-only-0000")
SHOTS = Path(sys.argv[1]) if len(sys.argv) > 1 else None
SAT_SHEET = "fakeSATleads000000000001"
IELTS_SHEET = "fakeIELTSleads0000000002"
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""))
    if not cond:
        raise SystemExit(1)


def shot(page, name):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.screenshot(path=str(SHOTS / f"{name}.png"))


def sql(query, params=None):
    """Runs SQL on the local test database as the superuser; returns rows as dicts."""
    js = (
        "const pg=require('pg');const c=new pg.Client(process.env.DATABASE_URL||'postgres://postgres:postgres@localhost:54329/crm');"
        "c.connect().then(()=>c.query(process.argv[1], JSON.parse(process.argv[2]))).then(r=>{process.stdout.write(JSON.stringify(r.rows));return c.end()})"
        ".catch(e=>{console.error(e.message);process.exit(1)})"
    )
    out = subprocess.run(["node", "-e", js, query, json.dumps(params or [])], capture_output=True, text=True, cwd=ROOT)
    if out.returncode:
        raise RuntimeError(out.stderr)
    return json.loads(out.stdout or "[]")


def fake(fn):
    data = json.loads(FAKE.read_text())
    fn(data)
    FAKE.write_text(json.dumps(data, ensure_ascii=False, indent=2))


def serial_now(minutes_ago=0):
    out = subprocess.run(["node", "--input-type=module", "-e",
                          f"import {{serialMinutesAgo}} from './scripts/fake-google.mjs'; process.stdout.write(String(serialMinutesAgo({minutes_ago})))"],
                         capture_output=True, text=True, cwd=ROOT)
    return float(out.stdout)


def tick(page, secret=CRON_SECRET):
    r = page.request.post(f"{BASE}/api/cron/tick", headers={"Authorization": f"Bearer {secret}"})
    return r.status, (r.json() if r.status == 200 else None)


def sign_in(ctx, name, path):
    page = ctx.new_page()
    page.goto(f"{BASE}/login")
    page.get_by_role("button", name=name).click()
    page.wait_for_url(f"**{path}*")
    return page


def ids():
    rows = sql("select id, full_name from public.profiles")
    return {r["full_name"].split()[0].lower(): r["id"] for r in rows}


# ── Setup: deterministic shifts so results do not depend on the time of day ──
P = ids()
progs = {r["code"]: r["id"] for r in sql("select id, code from public.programs")}
sql("delete from public.shifts")
for d in range(7):
    sql("insert into public.shifts (user_id, weekday, start_minute, end_minute, program_ids) values ($1, $2, 0, 0, $3)", [P["nour"], d, [progs["SAT"], progs["IELTS"]]])
    sql("insert into public.shifts (user_id, weekday, start_minute, end_minute, program_ids) values ($1, $2, 0, 0, $3)", [P["youssef"], d, [progs["SAT"]]])
    sql("insert into public.shifts (user_id, weekday, start_minute, end_minute, program_ids) values ($1, $2, 0, 0, $3)", [P["mariam"], d, [progs["IELTS"]]])
sql("update public.profiles set paused = false")

with sync_playwright() as p:
    browser = p.chromium.launch()
    mctx = browser.new_context(viewport={"width": 1440, "height": 900})
    m = sign_in(mctx, "Hana Farouk", "/overview")

    # ── 1. Connect the SAT sheet in a few clicks ──────────────────────────
    m.goto(f"{BASE}/settings/sheets")
    expect(m.get_by_text("No sheets connected yet")).to_be_visible()
    shot(m, "01-sheets-empty")
    m.get_by_role("button", name="Connect Google Sheet").click()
    m.wait_for_url("**/api/google/fake-consent*")
    check("Connect goes to the Google consent screen", "fake-consent" in m.url)
    expect(m.get_by_text("only the specific Google Drive files you use with this app")).to_be_visible()
    shot(m, "02-google-consent-simulated")
    m.get_by_role("link", name="Allow as academy.sheets@example.test").click()
    m.wait_for_url("**/settings/sheets*")
    expect(m.get_by_text("Google account connected. Now choose the lead sheet.")).to_be_visible()
    picker = m.get_by_role("dialog", name="Choose the lead sheet")
    expect(picker).to_be_visible()
    check("After sign-in the file picker opens by itself", True)
    acc = sql("select email, refresh_token_enc from public.google_accounts")
    check("Google sign-in stored encrypted (not plain text)", acc[0]["refresh_token_enc"].startswith("v1:") and "fake-refresh" not in acc[0]["refresh_token_enc"])
    picker.get_by_role("button", name="SAT Leads — Website Form").click()

    wiz = m.get_by_role("dialog", name="Connect “SAT Leads — Website Form”")
    expect(wiz.get_by_text("Step 1 of 3")).to_be_visible()
    expect(wiz.get_by_text("Form Responses 1")).to_be_visible()
    program_select = wiz.get_by_label("Program for this sheet")
    check("Program guessed from the sheet name (SAT)", program_select.input_value() == progs["SAT"])
    wiz.get_by_role("button", name="Next: check columns").click()
    expect(wiz.get_by_text("Step 2 of 3")).to_be_visible()
    expect(wiz.get_by_text("Preview of the first")).to_be_visible()

    def target_of(header):
        return wiz.get_by_label(f"CRM field for column {header}").input_value()
    fields = {r["key"]: r["id"] for r in sql("select id, key from public.field_definitions")}
    check("Columns matched automatically", target_of("Timestamp") == "submitted_at" and target_of("Full name") == "name"
          and target_of("Phone number (WhatsApp)") == "phone" and target_of("Grade") == f"field:{fields['grade']}"
          and target_of("School name") == f"field:{fields['school']}" and target_of("Any questions?") == "note",
          "Timestamp, Full name, Phone, Grade, School, Any questions")
    expect(wiz.get_by_text("Submitted again · logged on open inquiry")).to_be_visible()
    expect(wiz.get_by_text('Phone number is not valid: "12345"')).to_be_visible()
    check("Preview flags an existing customer and a bad row", True)
    shot(m, "03-wizard-matching-preview")

    # A manual change re-runs the preview; then put it back.
    wiz.get_by_label("CRM field for column School name").select_option("")
    expect(wiz.get_by_label("CRM field for column School name")).to_have_value("")
    wiz.get_by_label("CRM field for column School name").select_option(f"field:{fields['school']}")
    wiz.get_by_role("button", name="Next: start syncing").click()
    expect(wiz.get_by_text("Step 3 of 3")).to_be_visible()
    wiz.get_by_text("Import existing rows too").click()
    shot(m, "04-wizard-start")
    wiz.get_by_role("button", name="Start syncing").click()
    expect(m.get_by_text("Connected. 4 leads imported, 1 sent to Needs Review.")).to_be_visible()
    check("Import existing rows: 4 new leads, 1 to review", True)

    imported = sql("""select c.name, i.sales_owner_id, i.assignment_method, i.created_at from public.inquiries i
                      join public.contacts c on c.id = i.contact_id where i.source = 'google_sheet' order by i.created_at""")
    check("Every imported lead was assigned automatically", len(imported) == 4 and all(r["sales_owner_id"] and r["assignment_method"] == "round_robin" for r in imported))
    sat_owners = [r["sales_owner_id"] for r in imported]
    check("SAT leads alternate between the two SAT agents on shift", set(sat_owners) == {P["nour"], P["youssef"]}
          and abs(sat_owners.count(P["nour"]) - sat_owners.count(P["youssef"])) <= 1)
    hoda = sql("""select a.body from public.activities a join public.inquiries i on i.id = a.inquiry_id join public.contacts c on c.id = i.contact_id
                  where c.phone_normalized = '+201025550103' and a.type = 'resubmitted'""")
    check("Repeat submission logged on the existing open inquiry", len(hoda) == 1 and "row 4" in hoda[0]["body"])
    karim = sql("""select i.created_at, (select count(*) from public.field_values v where v.inquiry_id = i.id) as fields,
                   (select body from public.activities a where a.inquiry_id = i.id and a.type = 'comment' and body like 'Any questions%') as note
                   from public.inquiries i join public.contacts c on c.id = i.contact_id where c.name = 'Karim Mostafa'""")[0]
    check("Answers land in CRM fields and the timeline", int(karim["fields"]) >= 3 and "weekend classes" in karim["note"])
    m.reload()
    expect(m.get_by_text("SAT Leads — Website Form")).to_be_visible()
    expect(m.get_by_text("Syncing").first).to_be_visible()
    shot(m, "05-sheets-connected")

    # ── 2. Connect the Arabic IELTS sheet, new rows only ───────────────────
    m.get_by_role("button", name="Connect Google Sheet").click()
    m.get_by_role("dialog", name="Choose the lead sheet").get_by_role("button", name="IELTS Leads — نموذج التسجيل").click()
    wiz = m.get_by_role("dialog", name="Connect “IELTS Leads — نموذج التسجيل”")
    check("IELTS program guessed", wiz.get_by_label("Program for this sheet").input_value() == progs["IELTS"])
    wiz.get_by_role("button", name="Next: check columns").click()
    expect(wiz.get_by_text("Preview of the first")).to_be_visible()
    check("Arabic headers matched", target_of("طابع زمني") == "submitted_at" and target_of("الاسم بالكامل") == "name"
          and target_of("رقم الموبايل") == "phone" and target_of("ملاحظات") == "note")
    wiz.get_by_role("button", name="Next: start syncing").click()
    wiz.get_by_role("button", name="Start syncing").click()  # default: only rows added from now on
    expect(m.get_by_text("Connected. New rows will arrive automatically every 2 minutes.")).to_be_visible()
    check("New rows only: nothing old imported", len(sql("select 1 from public.inquiries i join public.programs p on p.id = i.program_id where i.source = 'google_sheet' and p.code = 'IELTS'")) == 0)

    # ── 3. A new form response arrives; the 2-minute scheduler picks it up ─
    status, _ = tick(m, "wrong-secret-wrong-secret-0000")
    check("Scheduler route refuses a wrong secret", status == 401)

    def add_ielts(row):
        fake(lambda d: d["spreadsheets"][IELTS_SHEET]["tabs"][0]["rows"].append(row))
    add_ielts([serial_now(1), "فرح جمال", "01005550399", "Academic", "عايزة كورس مكثف"])
    add_ielts([serial_now(1), "Omar Test", "0100", "Academic", ""])
    status, body = tick(m)
    ielts_conn = [c for c in body["connections"] if c["imported"] or c["review"]]
    check("Scheduler imports the new row and flags the bad one", status == 200 and sum(c["imported"] for c in body["connections"]) == 1 and sum(c["review"] for c in body["connections"]) == 1, json.dumps(body["connections"]))
    farah = sql("""select i.sales_owner_id from public.inquiries i join public.contacts c on c.id = i.contact_id where c.phone_normalized = '+201005550399'""")
    check("New IELTS lead went to an IELTS agent on shift", farah and farah[0]["sales_owner_id"] in (P["nour"], P["mariam"]))
    status, body = tick(m)
    check("Running again imports nothing twice", sum(c["imported"] + c["review"] for c in body["connections"]) == 0)

    # ── 4. Needs Review: fix one, dismiss one ─────────────────────────────
    m.goto(f"{BASE}/review")
    expect(m.get_by_text('Phone number is not valid: "12345"')).to_be_visible()
    expect(m.get_by_text('Phone number is not valid: "0100"')).to_be_visible()
    shot(m, "06-needs-review")
    card = m.get_by_role("article").filter(has_text='"0100"')
    card.get_by_role("button", name="Fix and import").click()
    fix = m.get_by_role("dialog", name="Fix and import")
    fix.get_by_label("Phone").fill("0100 555 0398")
    fix.get_by_role("button", name="Import lead").click()
    expect(m.get_by_text("Imported. The lead was assigned")).to_be_visible()
    card = m.get_by_role("article").filter(has_text='"12345"')
    card.get_by_role("button", name="Dismiss").click()
    dis = m.get_by_role("dialog", name="Dismiss this row?")
    dis.get_by_role("button", name="Test entry").click()
    dis.get_by_role("button", name="Dismiss", exact=True).click()
    expect(m.get_by_text("Nothing needs review")).to_be_visible()
    rv = sql("select status, resolution_note from public.review_items order by created_at")
    check("Review items resolved (one imported, one dismissed with reason)", sorted(r["status"] for r in rv) == ["dismissed", "imported"])
    fixed = sql("select i.source, i.sales_owner_id from public.inquiries i join public.contacts c on c.id = i.contact_id where c.phone_normalized = '+201005550398'")
    check("Fixed row became a Google Sheet lead and was assigned", fixed and fixed[0]["source"] == "google_sheet" and fixed[0]["sales_owner_id"])

    # ── 5. Sales agent: sees the lead, cannot reach sheet settings ─────────
    sctx = browser.new_context(viewport={"width": 1440, "height": 900})
    s = sign_in(sctx, "Nour Hassan", "/my-work")
    nour_sheet_leads = sql("select count(*)::int as n from public.inquiries where source = 'google_sheet' and sales_owner_id = $1", [P["nour"]])[0]["n"]
    q = json.dumps({"filters": {}, "sort": {"key": "created", "dir": "desc"}, "page": 0, "pageSize": 100})
    lead_rows = s.request.get(f"{BASE}/api/leads?q={q}").json()["rows"]
    mine = [r for r in lead_rows if r["inquiry"]["source"] == "google_sheet"]
    check("Agent sees exactly her imported leads", len(mine) == nour_sheet_leads and all(r["inquiry"]["salesOwnerId"] == P["nour"] for r in mine))
    for path in ["/api/sheets", "/api/review", "/api/distribution", "/api/google/picker"]:
        st = s.request.get(f"{BASE}{path}").status
        check(f"Agent refused at {path}", st == 403, f"status={st}")
    s.goto(f"{BASE}/settings/sheets")
    s.wait_for_url("**/my-work*")
    s.goto(f"{BASE}/review")
    s.wait_for_url("**/my-work*")
    check("Agent redirected away from Sheets settings and Needs Review", "/my-work" in s.url)
    r = s.request.get(f"{BASE}/api/google/connect", max_redirects=0)
    check("Agent cannot start a Google connection", r.status in (302, 307) and "fake-consent" not in (r.headers.get("location") or ""))

    # ── 6. Google access revoked → clear banner → one-click reconnect ──────
    fake(lambda d: d["accounts"]["academy.sheets@example.test"].update(revoked=True))
    tick(m)
    st = sql("select status from public.sheet_connections")
    check("Revoked Google access marks connections Reconnect", all(r["status"] == "reconnect" for r in st))
    note = sql("select text from public.notifications where user_id = $1 and text like 'Google Sheets stopped syncing%'", [P["hana"]])
    check("Managers notified once", len(note) == 1)
    m.goto(f"{BASE}/overview")
    expect(m.get_by_text("Reconnect Google").first).to_be_visible()
    m.goto(f"{BASE}/settings/sheets")
    expect(m.get_by_text("Google Sheets stopped syncing")).to_be_visible()
    shot(m, "07-reconnect-banner")
    fake(lambda d: d["accounts"]["academy.sheets@example.test"].update(revoked=False))
    m.get_by_role("button", name="Reconnect Google").click()
    m.wait_for_url("**/api/google/fake-consent*")
    m.get_by_role("link", name="Allow as academy.sheets@example.test").click()
    m.wait_for_url("**/settings/sheets*")
    m.keyboard.press("Escape")  # close the picker that opens after sign-in
    st = sql("select status from public.sheet_connections")
    check("Reconnecting resumes every connection with its matching kept", all(r["status"] == "active" for r in st))

    # ── 7. A renamed column pauses safely and heals when restored ─────────
    fake(lambda d: d["spreadsheets"][SAT_SHEET]["tabs"][0]["rows"][0].__setitem__(2, "Mobile"))
    fake(lambda d: d["spreadsheets"][SAT_SHEET]["tabs"][0]["rows"].append([serial_now(1), "Should Wait", "01005550397", "Student", "", "", "", "", ""]))
    tick(m)
    c = sql("select status, status_message from public.sheet_connections where spreadsheet_id = $1", [SAT_SHEET])[0]
    check("Renamed phone column stops that sheet with a plain message", c["status"] == "needs_attention" and '"Phone number (WhatsApp)"' in c["status_message"], c["status_message"])
    check("Nothing imported with the wrong columns", not sql("select 1 from public.contacts where name = 'Should Wait'"))
    m.goto(f"{BASE}/settings/sheets")
    expect(m.get_by_text("Needs attention").first).to_be_visible()
    shot(m, "08-needs-attention")
    fake(lambda d: d["spreadsheets"][SAT_SHEET]["tabs"][0]["rows"][0].__setitem__(2, "Phone number (WhatsApp)"))
    tick(m)
    c = sql("select status from public.sheet_connections where spreadsheet_id = $1", [SAT_SHEET])[0]
    check("Restoring the column heals it and the waiting row arrives", c["status"] == "active" and sql("select 1 from public.contacts where name = 'Should Wait'"))

    # ── 8. Shifts screen and the queue ────────────────────────────────────
    m.goto(f"{BASE}/settings/shifts")
    expect(m.get_by_text("Who receives new leads right now")).to_be_visible()
    expect(m.get_by_text("Receiving").first).to_be_visible()
    m.get_by_role("button", name="Add shift for Mariam Samir").click()
    dlg = m.get_by_role("dialog", name="Add shifts")
    for d in ["Sun", "Mon", "Tue", "Wed", "Thu"]:
        dlg.get_by_role("button", name=d, exact=True).click()  # clear the default weekdays
    dlg.get_by_role("button", name="Fri", exact=True).click()
    dlg.get_by_label("Starts").fill("22:00")
    dlg.get_by_label("Ends").fill("02:00")
    expect(dlg.get_by_text("Runs past midnight into the next day.")).to_be_visible()
    dlg.get_by_role("button", name="Save").click()
    expect(m.get_by_text("Shift added")).to_be_visible()
    added = sql("select weekday, start_minute, end_minute from public.shifts where user_id = $1 and start_minute = 1320", [P["mariam"]])
    check("Overnight shift saved from the screen", added == [{"weekday": 5, "start_minute": 1320, "end_minute": 120}])
    shot(m, "09-shifts")

    # Nobody on shift for IELTS → the next lead waits; a manager fixes shifts and runs assignment.
    sql("delete from public.shifts where $1 = any(program_ids)", [progs["IELTS"]])
    add_ielts([serial_now(0), "Waiting Lead", "01005550396", "Academic", ""])
    tick(m)
    w = sql("select i.sales_owner_id from public.inquiries i join public.contacts c on c.id = i.contact_id where c.name = 'Waiting Lead'")
    check("With nobody on shift the lead waits in the queue", w and w[0]["sales_owner_id"] is None)
    m.goto(f"{BASE}/overview")
    expect(m.get_by_text("Waiting Lead")).to_be_visible()
    for d in range(7):
        sql("insert into public.shifts (user_id, weekday, start_minute, end_minute, program_ids) values ($1, $2, 0, 0, $3)", [P["mariam"], d, [progs["IELTS"]]])
    shot(m, "10-overview-queue")
    m.get_by_role("button", name="Run assignment now").click()
    expect(m.get_by_text("1 lead assigned.")).to_be_visible()
    w = sql("select i.sales_owner_id from public.inquiries i join public.contacts c on c.id = i.contact_id where c.name = 'Waiting Lead'")
    check("Run assignment now gives it to the agent now on shift", w[0]["sales_owner_id"] == P["mariam"])
    m.reload()
    expect(m.get_by_text("Queue is empty")).to_be_visible()
    shot(m, "11-overview")

    # ── 9. Phone layout ───────────────────────────────────────────────────
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Hana Farouk", "/overview")
    for path in ["/settings/sheets", "/review", "/settings/shifts", "/overview"]:
        mp.goto(f"{BASE}{path}")
        mp.wait_for_load_state("networkidle")
        overflow = mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")
        check(f"{path} fits a phone screen", not overflow)
    mp.goto(f"{BASE}/settings/sheets")
    shot(mp, "12-sheets-phone")
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
