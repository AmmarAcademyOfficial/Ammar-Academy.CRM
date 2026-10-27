"""
CRM changes, Part E browser test (26 Oct 2026): a weekly series in the customer's Support tab —
the series line, moving this and the following sessions, removing the whole series, a single
session without series choices, and package hours entered before the CRM. Synthetic data only.

Runs against the production build and a freshly seeded local database:
  python3 tests/e2e/session_series_e2e.py [screenshot_dir]
"""
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

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


cairo_now = datetime.now(ZoneInfo("Africa/Cairo"))
start = (cairo_now + timedelta(days=10)).replace(hour=18, minute=0, second=0, microsecond=0)
DAY = start.strftime("%A")
sara = sql("""select e.id as enrollment, a.id as assignment from public.enrollments e join public.inquiries i on i.id = e.inquiry_id
              join public.contacts c on c.id = i.contact_id join public.teacher_assignments a on a.enrollment_id = e.id where c.name = 'Sara Nasser'""")[0]
series_rows = lambda: sql("""select id, series_id, to_char(starts_at at time zone 'Africa/Cairo', 'YYYY-MM-DD HH24:MI') as at from public.teacher_sessions
                             where assignment_id = $1 and series_id is not null order by starts_at""", [sara["assignment"]])
used_before = float(sql("select coalesce(sum(student_hours), 0)::float8 as u from public.teacher_sessions where enrollment_id = $1", [sara["enrollment"]])[0]["u"])
sql("update public.enrollments set package_hours_before = 3 where id = $1", [sara["enrollment"]])


def open_sessions(page):
    page.goto(f"{BASE}/customers")
    page.get_by_label("Search customers").fill("Sara")
    page.locator("[data-customer='Sara Nasser']:visible").first.click()
    panel = page.get_by_role("dialog", name="Customer details")
    panel.get_by_role("tab", name="Support").click()
    return panel.get_by_role("region", name="Sessions")


def fmt(h):
    return f"{h:g} h"


with sync_playwright() as p:
    browser = p.chromium.launch()
    uctx = browser.new_context(viewport={"width": 1440, "height": 900})
    u = sign_in(uctx, "Laila Ibrahim", "/my-work")
    sec = open_sessions(u)
    expect(sec.get_by_test_id("package")).to_contain_text(f"{fmt(used_before + 3)} used")
    check("Package hours used before the CRM count in the package bar", True, f"{used_before:g} + 3 h")

    # ── 1. Schedule a weekly series; it shows as one line ───────────────────
    sec.get_by_role("button", name="Schedule").click()
    d = u.get_by_role("dialog", name="Schedule session")
    d.get_by_label("Date and time").fill(start.strftime("%Y-%m-%dT%H:%M"))
    d.get_by_label("Repeat weekly").select_option("3")
    d.get_by_role("button", name="Schedule").click()
    expect(u.get_by_text("4 weekly sessions scheduled")).to_be_visible()
    expect(sec.get_by_role("list", name="Weekly series")).to_contain_text(f"Weekly · {DAY}s 6:00 PM · 4 of 4 left")
    check("A weekly series is linked and shown as one line", len(series_rows()) == 4 and len({r["series_id"] for r in series_rows()}) == 1)

    # ── 2. Move this and the following sessions ─────────────────────────────
    show_all = sec.get_by_role("button", name="Show all")
    if show_all.count():
        show_all.click()
    second = (start + timedelta(days=7))
    row = sec.locator("li[data-session='scheduled']").filter(has_text=second.strftime("%-d %b"))
    row.get_by_role("button", name="Record").click()
    d = u.get_by_role("dialog", name="Record session")
    expect(d.get_by_test_id("series-scope")).to_contain_text("This and the following (3)")
    expect(d.get_by_test_id("series-scope")).to_contain_text("All not yet recorded (4)")
    d.get_by_label("This and the following (3)").check()
    new = second + timedelta(days=1, hours=1)
    d.get_by_label("Date and time").fill(new.strftime("%Y-%m-%dT%H:%M"))
    shot(u, "01-series-move")
    d.get_by_role("button", name="Save").click()
    expect(u.get_by_text("3 sessions moved")).to_be_visible()
    at = [r["at"] for r in series_rows()]
    expected = [start.strftime("%Y-%m-%d %H:%M")] + [(new + timedelta(days=7 * k)).strftime("%Y-%m-%d %H:%M") for k in range(3)]
    check("This and the following sessions move by the same amount; the first stays", at == expected, json.dumps(at))

    # ── 3. Remove the whole series ──────────────────────────────────────────
    first_row = sec.locator("li[data-session='scheduled']").filter(has_text=start.strftime("%-d %b"))
    first_row.get_by_role("button", name="Record").click()
    d = u.get_by_role("dialog", name="Record session")
    d.get_by_label("All not yet recorded (4)").check()
    d.get_by_role("button", name="Remove 4").click()
    expect(u.get_by_text("4 sessions removed")).to_be_visible()
    check("The whole series is removed in one step", len(series_rows()) == 0)
    acts = sql("""select body from public.activities a join public.enrollments e on e.inquiry_id = a.inquiry_id
                  where e.id = $1 and a.type = 'session' order by a.created_at desc limit 2""", [sara["enrollment"]])
    check("The timeline records each change once", acts[0]["body"].startswith("4 sessions with Dina Kamal removed (the whole series)")
          and acts[1]["body"].startswith("3 sessions with Dina Kamal moved to"), json.dumps(acts))

    # ── 4. A single session has no series choices ───────────────────────────
    sec.get_by_role("button", name="Schedule").click()
    d = u.get_by_role("dialog", name="Schedule session")
    d.get_by_label("Date and time").fill((start + timedelta(days=2)).strftime("%Y-%m-%dT%H:%M"))
    d.get_by_role("button", name="Schedule").click()
    expect(u.get_by_text("Session scheduled", exact=True)).to_be_visible()
    sec.locator("li[data-session='scheduled']").filter(has_text=(start + timedelta(days=2)).strftime("%-d %b")).get_by_role("button", name="Record").click()
    d = u.get_by_role("dialog", name="Record session")
    expect(d.get_by_label("Date and time")).to_be_visible()
    check("A single session shows no series choices", d.get_by_test_id("series-scope").count() == 0)
    d.get_by_role("button", name="Cancel").click()

    # ── 5. Phone layout ─────────────────────────────────────────────────────
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Laila Ibrahim", "/my-work")
    msec = open_sessions(mp)
    msec.get_by_role("button", name="Schedule").click()
    md = mp.get_by_role("dialog", name="Schedule session")
    md.get_by_label("Date and time").fill((start + timedelta(days=30)).strftime("%Y-%m-%dT%H:%M"))
    md.get_by_label("Repeat weekly").select_option("1")
    md.get_by_role("button", name="Schedule").click()
    expect(mp.get_by_text("2 weekly sessions scheduled")).to_be_visible()
    check("Sessions and series fit a phone", not mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    shot(mp, "02-phone", full=True)
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
