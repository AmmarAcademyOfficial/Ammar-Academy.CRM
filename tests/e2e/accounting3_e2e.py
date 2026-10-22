"""
Accounting plan, phase 3 browser test (22 Oct 2026): teachers and hourly rates in Settings, dated
rate changes, group course teachers, support assigning a private teacher, and the phone shortcut
to Accounting.

Runs against the production build and a freshly seeded local database:
  python3 tests/e2e/accounting3_e2e.py [screenshot_dir]
Synthetic data only.
"""
import json
import re
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
import hydration  # noqa: F401  (waits for the page to be interactive after each load)

BASE = "http://localhost:3000"
ROOT = Path(__file__).parents[2]
SHOTS = Path(sys.argv[1]) if len(sys.argv) > 1 else None
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""))
    if not cond:
        raise SystemExit(1)


def shot(page, name, full=False):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.wait_for_timeout(400)
        page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=full)


def sql(query, params=None):
    js = (
        "const pg=require('pg');const c=new pg.Client('postgres://postgres:postgres@localhost:54329/crm');"
        "c.connect().then(()=>c.query(process.argv[1], JSON.parse(process.argv[2]))).then(r=>{process.stdout.write(JSON.stringify(r.rows));return c.end()})"
        ".catch(e=>{console.error(e.message);process.exit(1)})"
    )
    out = subprocess.run(["node", "-e", js, query, json.dumps(params or [])], capture_output=True, text=True, cwd=ROOT)
    if out.returncode:
        raise RuntimeError(out.stderr)
    return json.loads(out.stdout or "[]")


def sign_in(ctx, name, path):
    page = ctx.new_page()
    page.goto(f"{BASE}/login")
    page.get_by_role("button", name=name).click()
    page.wait_for_url(f"**{path}*")
    return page


today = (datetime.now(timezone.utc) + timedelta(hours=3)).date()
next26 = (date(today.year + (today.month == 12 and today.day >= 26), (today.month % 12) + 1 if today.day >= 26 else today.month, 26))
laila = sql("select id from public.profiles where full_name = 'Laila Ibrahim'")[0]["id"]
jana = sql("""select i.id as inquiry, e.id as enrollment, o.id as onboarding from public.inquiries i join public.contacts c on c.id = i.contact_id
              join public.enrollments e on e.inquiry_id = i.id join public.onboardings o on o.enrollment_id = e.id where c.name = 'Jana Ezzat'""")[0]
sql("update public.onboardings set support_owner_id = $1, claimed_at = now(), status = 'onboarding' where id = $2", [laila, jana["onboarding"]])

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── 1. Settings → Teachers and Rates ────────────────────────────────────
    mctx = browser.new_context(viewport={"width": 1440, "height": 900})
    m = sign_in(mctx, "Hana Farouk", "/overview")
    m.goto(f"{BASE}/settings/teachers")
    m.wait_for_load_state("networkidle")  # a click before the page is interactive does nothing
    sami = m.locator("li[data-teacher='Ahmed Sami']")
    expect(sami.locator("li[data-rate='SAT private'] [data-amount]")).to_have_text("400 EGP / hour")
    expect(sami.locator("li[data-rate='SAT group'] [data-amount]")).to_have_text("600 EGP / hour")
    expect(sami.get_by_role("list", name="Teaching now: Ahmed Sami")).to_contain_text("Group: SAT · March 2027 Full Course · Math")
    check("Teachers are listed with several hourly rates and what they teach", True)

    m.get_by_role("button", name="Add teacher").click()
    d = m.get_by_role("dialog", name="Add teacher")
    d.get_by_label("Full name").fill("Omar Fathy")
    d.get_by_label("Phone").fill("+20 100 222 3333")
    d.get_by_label("SAT").check()
    d.get_by_role("button", name="Save").click()
    expect(m.get_by_text("Teacher added")).to_be_visible()
    omar = m.locator("li[data-teacher='Omar Fathy']")
    omar.get_by_role("button", name="Add rate").click()
    d = m.get_by_role("dialog", name="Add a rate for Omar Fathy")
    d.get_by_label("Rate name").fill("SAT private")
    d.get_by_label("Amount per hour (EGP)").fill("420")
    d.get_by_role("button", name="Add rate").click()
    expect(omar.locator("li[data-rate='SAT private'] [data-amount]")).to_have_text("420 EGP / hour")
    t = sql("select t.id, t.program_ids::text[] as programs, r.id as rate from public.teachers t join public.teacher_rates r on r.teacher_id = t.id where t.full_name = 'Omar Fathy'")[0]
    check("A manager adds a teacher and a rate", len(t["programs"]) == 1)

    omar.locator("li[data-rate='SAT private']").get_by_role("button", name="Change amount").click()
    d = m.get_by_role("dialog", name="Change SAT private")
    expect(d.get_by_label("Starts from")).to_have_value(next26.isoformat())
    check("A new amount starts on the next 26th by default", True, next26.isoformat())
    d.get_by_label(re.compile("New amount per hour")).fill("480")
    d.get_by_role("button", name="Save new amount").click()
    expect(m.get_by_text("New amount saved")).to_be_visible()
    row = omar.locator("li[data-rate='SAT private']")
    expect(row.locator("[data-amount]")).to_have_text("420 EGP / hour")
    expect(row).to_contain_text(re.compile(r"480 EGP from \d{1,2} \w{3,4} \d{4}"))
    amounts = sql("select amount::float8 as a, to_char(valid_from, 'YYYY-MM-DD') as f from public.teacher_rate_amounts where rate_id = $1 order by valid_from", [t["rate"]])
    check("A rate change keeps the old amount until its date", [x["a"] for x in amounts] == [420, 480] and amounts[1]["f"] == next26.isoformat(), str(amounts))
    shot(m, "01-teachers", full=True)

    omar.get_by_role("button", name="Assign to a group course").click()
    d = m.get_by_role("dialog", name="Assign Omar Fathy to a group course")
    d.get_by_label("Course").select_option(label="SAT · December 2026 Intensive")
    d.get_by_role("button", name="Assign").click()
    expect(m.get_by_text("Teacher assigned to the group")).to_be_visible()
    m.goto(f"{BASE}/settings/courses")
    expect(m.locator("li").filter(has_text="SAT · December 2026 Intensive").locator("[data-course-teachers]")).to_have_text("Teacher: Omar Fathy")
    check("Group course teachers show in the course list", True)
    audit = sql("select count(*)::int as n from public.audit_log where target = 'Omar Fathy'")[0]["n"]
    check("Teacher and rate changes are in the audit history", audit >= 3, f"{audit} entries")

    # ── 2. Support assigns a private teacher ────────────────────────────────
    uctx = browser.new_context(viewport={"width": 1440, "height": 900})
    u = sign_in(uctx, "Laila Ibrahim", "/my-work")
    u.locator("li").filter(has_text="Jana Ezzat").filter(has_text=" paid").first.get_by_role("button").first.click()
    panel = u.get_by_role("dialog", name="Customer details")
    panel.get_by_role("tab", name="Support").click()
    sec = panel.get_by_role("region", name="Teachers")
    expect(sec).to_contain_text("Ahmed Sami")
    expect(sec).to_contain_text("Group course teacher")
    check("The customer's group course teacher is shown", True)
    sec.get_by_role("button", name="Assign teacher").click()
    d = u.get_by_role("dialog", name="Assign teacher")
    d.get_by_label("Teacher").select_option(label="Omar Fathy")
    opts = d.get_by_label("Rate").locator("option").all_inner_texts()
    check("Support sees rate names but not the amounts", opts == ["SAT private"], str(opts))
    d.get_by_label("Subject (optional)").fill("Reading")
    d.get_by_role("button", name="Assign").click()
    expect(u.get_by_text("Teacher assigned")).to_be_visible()
    expect(sec.locator("li[data-assignment='Omar Fathy']")).to_contain_text("Reading")
    a = sql("select subject, ended_on, created_by from public.teacher_assignments where enrollment_id = $1", [jana["enrollment"]])
    check("Support's assignment is saved", a == [{"subject": "Reading", "ended_on": None, "created_by": laila}], str(a))
    shot(u, "02-support-teachers")
    sec.locator("li[data-assignment='Omar Fathy']").get_by_role("button", name="Stop").click()
    expect(sec).to_contain_text("Before: Omar Fathy (Reading) until")
    check("Stopping a teacher keeps them on record", sql("select count(*)::int as n from public.teacher_assignments where enrollment_id = $1 and ended_on is not null", [jana["enrollment"]])[0]["n"] == 1)
    timeline = sql("select count(*)::int as n from public.activities where inquiry_id = $1 and type = 'teacher'", [jana["inquiry"]])[0]["n"]
    check("Teacher changes are on the customer's timeline", timeline == 2)
    u.keyboard.press("Escape")

    # ── 3. The sales agent sees teachers, read only ─────────────────────────
    sctx = browser.new_context(viewport={"width": 1440, "height": 900})
    s = sign_in(sctx, "Youssef Adel", "/my-work")
    s.goto(f"{BASE}/leads")
    s.get_by_placeholder(re.compile("Search name or phone")).fill("Jana Ezzat")
    s.wait_for_timeout(900)
    s.locator("tbody tr").filter(has_text="Jana Ezzat").first.click()
    sp = s.get_by_role("dialog", name="Customer details")
    sp.get_by_role("tab", name="Support").click()
    ssec = sp.get_by_role("region", name="Teachers")
    expect(ssec).to_contain_text("Ahmed Sami")
    check("The sales agent sees teachers but cannot assign them", ssec.get_by_role("button", name="Assign teacher").count() == 0)

    # ── 4. Phone: Accounting shortcut, teachers page fits ───────────────────
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Hana Farouk", "/overview")
    mp.goto(f"{BASE}/settings")
    expect(mp.get_by_role("link", name="Accounting")).to_be_visible()
    check("Managers reach Accounting on a phone from More", True)
    mp.goto(f"{BASE}/settings/teachers")
    mp.wait_for_load_state("networkidle")
    check("Teachers and Rates fits a phone", not mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    shot(mp, "03-phone-teachers", full=True)
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
