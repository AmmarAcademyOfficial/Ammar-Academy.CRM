"""
Accounting plan, phase 5 browser test (22 Oct 2026): Accounting → Teachers. Salaries per Academy
month from recorded session hours, bonus and deduction lines, CSV export, closing and reopening a
month (managers only), who can open it, and the phone layout.

Uses the Academy month three months back, so the seed's sessions (which move with today's date)
never fall into it and the figures below are fixed.

Runs against the production build and a freshly seeded local database:
  python3 tests/e2e/accounting5_e2e.py [screenshot_dir]
Synthetic data only.
"""
import json
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


def month_key(d: date, back: int):
    """'YYYY-MM' of the Academy month containing d, `back` months earlier."""
    y, m = d.year, d.month + (1 if d.day >= 26 else 0) - back
    while m < 1:
        y, m = y - 1, m + 12
    while m > 12:
        y, m = y + 1, m - 12
    return f"{y}-{m:02d}"


MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
today = (datetime.now(timezone.utc) + timedelta(hours=3)).date()
P = month_key(today, 3)
P_LABEL = f"{MONTHS[int(P[5:]) - 1]} {P[:4]}"
py, pm = int(P[:4]), int(P[5:])
day = lambda d: f"{py}-{pm:02d}-{d:02d}"  # a day in the month the period ends in (1st–25th)

# Known sessions in that month: Dina 2 h private (450/h), Ahmed 2 h group (600/h).
dina = sql("""select a.id, a.rate_id from public.teacher_assignments a join public.teachers t on t.id = a.teacher_id where t.full_name = 'Dina Kamal' and a.enrollment_id is not null""")[0]
ahmed = sql("""select a.id, a.rate_id, a.course_id from public.teacher_assignments a join public.teachers t on t.id = a.teacher_id where t.full_name = 'Ahmed Sami' and a.course_id is not null""")[0]
for r in (dina, ahmed):
    sql("insert into public.teacher_rate_amounts (rate_id, amount, valid_from) select $1, amount, '2020-01-01' from public.teacher_rate_amounts where rate_id = $1 order by valid_from limit 1", [r["rate_id"]])
sql("""insert into public.teacher_sessions (assignment_id, teacher_id, rate_id, enrollment_id, starts_at, planned_hours, status, hours, paid_hours, student_hours)
       select a.id, a.teacher_id, a.rate_id, a.enrollment_id, $2::timestamptz, 2, 'done', 2, 2, 2 from public.teacher_assignments a where a.id = $1""", [dina["id"], f"{day(5)}T17:00:00+03:00"])
sql("""insert into public.teacher_sessions (assignment_id, teacher_id, rate_id, course_id, starts_at, planned_hours, status, hours, paid_hours, student_hours)
       select a.id, a.teacher_id, a.rate_id, a.course_id, $2::timestamptz, 2, 'done', 2, 2, 0 from public.teacher_assignments a where a.id = $1""", [ahmed["id"], f"{day(10)}T19:00:00+03:00"])


def open_month(page):
    page.goto(f"{BASE}/accounting?tab=teachers")
    page.wait_for_load_state("networkidle")
    for _ in range(3):
        page.get_by_role("button", name="Previous month").click()
    expect(page.get_by_test_id("salary-month")).to_have_text(P_LABEL)


with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── 1. Accountant: the month's pay, bonus and deduction, CSV ────────────
    actx = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
    a = sign_in(actx, "Karim Fawzy", "/accounting")
    open_month(a)
    dcard = a.locator("[data-teacher='Dina Kamal']")
    acard = a.locator("[data-teacher='Ahmed Sami']")
    expect(dcard.locator("[data-line='IELTS private']")).to_contain_text("2 h × 450 EGP")
    expect(dcard.get_by_test_id("teacher-total")).to_have_text("900 EGP")
    expect(acard.get_by_test_id("teacher-total")).to_have_text("1,200 EGP")
    expect(a.get_by_test_id("salary-total")).to_have_text("2,100 EGP")
    check("Pay per teacher = recorded hours × the hourly rate, group classes paid once", True, "900 + 1,200 EGP")
    expect(a.get_by_text("Ended · not closed")).to_be_visible()
    check("Accountants cannot close a month", a.get_by_role("button", name="Close month").count() == 0)

    dcard.get_by_role("button", name="Add").click()
    d = a.get_by_role("dialog", name="Bonus or deduction")
    expect(d.get_by_label("Teacher")).to_have_value(sql("select id from public.teachers where full_name = 'Dina Kamal'")[0]["id"])
    d.get_by_label("Amount").fill("150")
    d.get_by_label("Reason").fill("Extra mock exam")
    d.get_by_role("button", name="Save").click()
    expect(a.get_by_text("Bonus added")).to_be_visible()
    acard.get_by_role("button", name="Add").click()
    d = a.get_by_role("dialog", name="Bonus or deduction")
    d.get_by_label("Type").select_option("deduction")
    d.get_by_label("Amount").fill("50")
    d.get_by_label("Reason").fill("Started a class late")
    d.get_by_role("button", name="Save").click()
    expect(a.get_by_text("Deduction added")).to_be_visible()
    expect(dcard.get_by_test_id("teacher-total")).to_have_text("1,050 EGP")
    expect(acard.get_by_test_id("teacher-total")).to_have_text("1,150 EGP")
    expect(a.get_by_test_id("salary-total")).to_have_text("2,200 EGP")
    check("Bonus and deduction lines change the totals", True, "1,050 + 1,150 EGP")
    shot(a, "01-accountant-teachers", full=True)

    with a.expect_download() as dl:
        a.get_by_role("button", name="Export CSV").click()
    csv = Path(dl.value.path()).read_text(encoding="utf-8")
    check("CSV export lists lines, adjustments and totals",
          dl.value.suggested_filename == f"salaries-{P}.csv" and "Dina Kamal,IELTS private,2,1,450,EGP,900" in csv and "Bonus: Extra mock exam" in csv and "Ahmed Sami,Total,,,,EGP,1150" in csv,
          dl.value.suggested_filename)

    # ── 2. Manager: unrecorded sessions block closing; close; reopen ───────
    sql("""insert into public.teacher_sessions (assignment_id, teacher_id, rate_id, enrollment_id, starts_at, planned_hours, status)
           select a.id, a.teacher_id, a.rate_id, a.enrollment_id, $2::timestamptz, 2, 'scheduled' from public.teacher_assignments a where a.id = $1""", [dina["id"], f"{day(12)}T17:00:00+03:00"])
    mctx = browser.new_context(viewport={"width": 1440, "height": 900})
    m = sign_in(mctx, "Hana Farouk", "/overview")
    open_month(m)
    expect(m.get_by_test_id("unrecorded-note")).to_contain_text("1 past session is not recorded yet")
    m.get_by_role("button", name="Close month").click()
    d = m.get_by_role("dialog", name=f"Close {P_LABEL}?")
    expect(d.get_by_role("button", name="Close month")).to_be_disabled()
    check("A month with unrecorded sessions cannot be closed", True)
    d.get_by_role("button", name="Cancel").click()

    sql("delete from public.teacher_sessions where status = 'scheduled' and starts_at = $1::timestamptz", [f"{day(12)}T17:00:00+03:00"])
    open_month(m)
    expect(m.get_by_test_id("unrecorded-note")).to_have_count(0)
    m.get_by_role("button", name="Close month").click()
    d = m.get_by_role("dialog", name=f"Close {P_LABEL}?")
    expect(d).to_contain_text("2,200 EGP")
    d.get_by_role("button", name="Close month").click()
    expect(m.get_by_text(f"{P_LABEL} closed")).to_be_visible()
    expect(m.get_by_test_id("closed-note")).to_contain_text("Closed by Hana Farouk")
    expect(m.get_by_role("button", name="Bonus or deduction")).to_have_count(0)
    st = sql("select status from public.salary_months where month = $1::date", [f"{P}-01"])
    check("Managers close the month; it is frozen and adjustments are locked", st and st[0]["status"] == "closed")
    shot(m, "02-manager-closed")
    try:
        sql("update public.teacher_sessions set paid_hours = 3 where starts_at = $1::timestamptz", [f"{day(5)}T17:00:00+03:00"])
        frozen = False
    except RuntimeError as e:
        frozen = "closed" in str(e)
    check("Sessions in a closed month can no longer change", frozen)

    m.get_by_role("button", name="Reopen").click()
    d = m.get_by_role("dialog", name=f"Reopen {P_LABEL}?")
    d.get_by_label("Reason").fill("Hours for one class were wrong")
    d.get_by_role("button", name="Reopen").click()
    expect(m.get_by_text(f"{P_LABEL} reopened")).to_be_visible()
    expect(m.get_by_text("Reopened: Hours for one class were wrong")).to_be_visible()
    check("Managers reopen with a reason", sql("select status from public.salary_months where month = $1::date", [f"{P}-01"])[0]["status"] == "open")

    # ── 3. Who can open it; phone layout ────────────────────────────────────
    uctx = browser.new_context(viewport={"width": 1440, "height": 900})
    u = sign_in(uctx, "Laila Ibrahim", "/my-work")
    check("Support cannot read salaries", u.request.get(f"{BASE}/api/salaries?month={P}").status == 403)
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Karim Fawzy", "/accounting")
    open_month(mp)
    expect(mp.locator("[data-teacher='Dina Kamal']")).to_be_visible()
    check("Teachers tab fits a phone", not mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    shot(mp, "03-phone", full=True)
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
