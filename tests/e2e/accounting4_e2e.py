"""
Accounting plan, phase 4 browser test (22 Oct 2026): the Sessions page, recording sessions (done,
cancelled late or in time), scheduling a weekly series from the customer's Support tab, package
hours, the session rules in Settings, and who sees the page.

Runs against the production build and a freshly seeded local database:
  python3 tests/e2e/accounting4_e2e.py [screenshot_dir]
Synthetic data only.
"""
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

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


cairo_now = datetime.now(timezone.utc) + timedelta(hours=3)
sara = sql("""select e.id as enrollment, i.id as inquiry, a.id as assignment from public.enrollments e join public.inquiries i on i.id = e.inquiry_id
              join public.contacts c on c.id = i.contact_id join public.teacher_assignments a on a.enrollment_id = e.id where c.name = 'Sara Nasser'""")[0]
sess = lambda: sql("select id, status, hours::float8 as hours, paid_hours::float8 as paid, student_hours::float8 as student, late_cancel from public.teacher_sessions where assignment_id = $1 order by starts_at", [sara["assignment"]])

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── 1. Support: the Sessions page and what needs recording ──────────────
    uctx = browser.new_context(viewport={"width": 1440, "height": 900})
    u = sign_in(uctx, "Laila Ibrahim", "/my-work")
    u.get_by_role("link", name="Sessions").first.click()
    u.wait_for_url("**/sessions")
    need = u.get_by_role("list", name="Needs recording")
    row = need.locator("li").filter(has_text="Sara Nasser").first
    expect(row).to_contain_text("Dina Kamal")
    check("Yesterday's unrecorded session is listed under Needs recording", True)
    shot(u, "01-sessions-needs-recording")
    row.get_by_role("button", name="Record").click()
    d = u.get_by_role("dialog", name="Record session")
    expect(d.get_by_label("What happened?")).to_have_value("done")
    d.get_by_label("Hours taught").fill("1.25")
    expect(d.get_by_test_id("paid-preview")).to_contain_text("Paid to the teacher: 1.25 h")
    d.get_by_role("button", name="Save").click()
    expect(u.get_by_text("Session recorded")).to_be_visible()
    rows = sess()
    check("Recording a session saves the real hours for pay and the package",
          rows[2]["status"] == "done" and rows[2]["hours"] == 1.25 and rows[2]["paid"] == 1.25 and rows[2]["student"] == 1.25, str(rows[2]))
    check("Needs recording empties once recorded", need.count() == 0 or need.locator("li").filter(has_text="Sara Nasser").count() == 0)

    # ── 2. The customer's Support tab: package and a weekly series ──────────
    u.goto(f"{BASE}/my-work")
    u.locator("li").filter(has_text="Sara Nasser").filter(has_text=" paid").first.get_by_role("button").first.click()
    panel = u.get_by_role("dialog", name="Customer details")
    panel.get_by_role("tab", name="Support").click()
    sec = panel.get_by_role("region", name="Sessions")
    expect(sec.get_by_test_id("package")).to_contain_text("4.25 h used of 36 h")
    check("Package hours: done and late-cancelled sessions count", True, "1.5 + 1.5 + 1.25 of 36")
    sec.get_by_role("button", name="Schedule").click()
    d = u.get_by_role("dialog", name="Schedule session")
    d.get_by_label("Date and time").fill((cairo_now + timedelta(days=2)).strftime("%Y-%m-%dT18:00"))
    d.get_by_label("Repeat weekly").select_option("3")
    d.get_by_role("button", name="Schedule").click()
    expect(u.get_by_text("4 weekly sessions scheduled")).to_be_visible()
    check("A weekly series is scheduled from the Support tab", len(sess()) == 8, f"{len(sess())} sessions")
    shot(u, "02-support-sessions")

    # A session that already happened, added and recorded as cancelled in good time: not paid.
    sec.get_by_role("button", name="Schedule").click()
    d = u.get_by_role("dialog", name="Schedule session")
    past = (cairo_now - timedelta(days=2)).strftime("%Y-%m-%dT10:00")
    d.get_by_label("Date and time").fill(past)
    d.get_by_role("button", name="Schedule").click()
    expect(u.get_by_text("Session scheduled", exact=True)).to_be_visible()
    target = sec.locator("li").filter(has_text="Needs recording").first
    target.get_by_role("button", name="Record").click()
    d = u.get_by_role("dialog", name="Record session")
    d.get_by_label("What happened?").select_option("cancelled_student")
    expect(d.get_by_test_id("paid-preview")).to_contain_text("Paid to the teacher: 0 h")
    d.get_by_label(re.compile("Cancelled less than 6 hours")).check()
    expect(d.get_by_test_id("paid-preview")).to_contain_text("Paid to the teacher: 2 h")
    d.get_by_label(re.compile("Cancelled less than 6 hours")).uncheck()
    d.get_by_role("button", name="Save").click()
    expect(u.get_by_text("Session recorded")).to_be_visible()
    cancelled = [r for r in sess() if r["status"] == "cancelled_student" and not r["late_cancel"]]
    check("A cancellation in good time pays nothing and uses no hours", len(cancelled) == 1 and cancelled[0]["paid"] == 0 and cancelled[0]["student"] == 0)
    acts = sql("select count(*)::int as n from public.activities where inquiry_id = $1 and type = 'session'", [sara["inquiry"]])[0]["n"]
    check("Sessions are on the customer's timeline", acts >= 4, f"{acts} entries")
    u.keyboard.press("Escape")

    # ── 3. Manager: all sessions, week view, rules in Settings ──────────────
    mctx = browser.new_context(viewport={"width": 1440, "height": 900})
    m = sign_in(mctx, "Hana Farouk", "/overview")
    m.goto(f"{BASE}/sessions")
    m.get_by_role("tab", name="Week").click()
    expect(m.get_by_test_id("session-range")).to_contain_text("–")
    m.get_by_label("Teacher").select_option(label="Dina Kamal")
    expect(m.get_by_role("main").get_by_text("Group: SAT · March 2027 Full Course")).to_have_count(0)
    check("Managers see the week and can filter by teacher", True)
    shot(m, "03-manager-week")
    m.goto(f"{BASE}/settings/teachers")
    sw = m.get_by_role("switch", name="No-shows are paid")
    expect(sw).to_have_attribute("aria-checked", "true")
    sw.click()
    expect(sw).to_have_attribute("aria-checked", "false")
    m.wait_for_timeout(800)
    check("Session rules are editable in Settings", sql("select no_show_paid from public.app_settings")[0]["no_show_paid"] is False)
    sw.click()
    m.wait_for_timeout(800)

    # ── 4. Sales cannot open Sessions; phone layout ─────────────────────────
    sctx = browser.new_context(viewport={"width": 1440, "height": 900})
    s = sign_in(sctx, "Youssef Adel", "/my-work")
    s.goto(f"{BASE}/sessions")
    s.wait_for_url("**/my-work")
    check("Sales agents are sent back from Sessions", s.request.get(f"{BASE}/api/sessions?from=2026-10-01&to=2026-10-31").status == 403)
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Laila Ibrahim", "/my-work")
    mp.goto(f"{BASE}/sessions")
    mp.wait_for_load_state("networkidle")
    check("Sessions fits a phone", not mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    shot(mp, "04-phone")
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
