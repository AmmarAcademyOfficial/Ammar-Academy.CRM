"""
Phase 5 browser test: reports (figures match the database, filters, CSV export, permissions),
audit history, health check, security headers, scheduler secret, and the unused-receipt clean-up.

Runs against the production build and a freshly seeded local database:
  python3 tests/e2e/phase5_e2e.py [screenshot_dir]
Synthetic data only.
"""
import csv
import io
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
import hydration  # noqa: F401  (waits for the page to be interactive after each load)

BASE = "http://localhost:3000"
ROOT = Path(__file__).parents[2]
SHOTS = Path(sys.argv[1]) if len(sys.argv) > 1 else None
CRON = os.environ.get("CRON_SECRET", "local-cron-secret-for-tests-only-0000")
RECEIPTS = ROOT / os.environ.get("RECEIPTS_DIR", ".local/receipts")
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""))
    if not cond:
        raise SystemExit(1)


def shot(page, name, full=False):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
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


today = sql("select (now() at time zone 'Africa/Cairo')::date::text as d")[0]["d"]
month_ago = sql("select ((now() at time zone 'Africa/Cairo')::date - 29)::text as d")[0]["d"]
group_type = sql("select id from public.course_types where name = 'Group course'")[0]["id"]

with sync_playwright() as p:
    browser = p.chromium.launch()
    mctx = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
    m = sign_in(mctx, "Hana Farouk", "/overview")

    # ── 1. Reports match the database ────────────────────────────────────
    api = m.request.get(f"{BASE}/api/reports?from={month_ago}&to={today}").json()
    db_new = sql("select count(*)::int as n from public.inquiries where created_at >= ($1::date)::timestamp at time zone 'Africa/Cairo'", [month_ago])[0]["n"]
    db_enr = sql("select count(*)::int as n from public.onboardings where created_at >= ($1::date)::timestamp at time zone 'Africa/Cairo'", [month_ago])[0]["n"]
    db_paid = sql("select coalesce(sum(amount), 0)::float as s from public.payments where status = 'confirmed' and decided_at >= ($1::date)::timestamp at time zone 'Africa/Cairo'", [month_ago])[0]["s"]
    check("Reports: new inquiries match the database", api["newInquiries"] == db_new, f"{api['newInquiries']}")
    check("Reports: enrollments match handovers in the database", api["enrollments"] == db_enr, f"{api['enrollments']}")
    check("Reports: confirmed payments match (rejected and pending excluded)", sum(c["amount"] for c in api["confirmed"]) == db_paid, f"{db_paid:.0f} EGP")
    m.goto(f"{BASE}/reports")
    expect(m.get_by_text("Sales agents")).to_be_visible()
    stat = m.locator("div").filter(has_text="New inquiries").filter(has_text="contacts").last
    expect(stat).to_contain_text(str(db_new))
    expect(m.get_by_role("row").filter(has_text="Nour Hassan")).to_be_visible()
    shot(m, "01-reports", full=True)

    # Course type filter changes the figures and matches the API.
    m.get_by_label("Course type").select_option(label="Group course")
    filtered = m.request.get(f"{BASE}/api/reports?from={month_ago}&to={today}&courseType={group_type}").json()
    expect(m.get_by_role("row").filter(has_text="SAT · December 2026 Intensive")).to_have_count(0)
    check("Course type filter narrows the report", filtered["newInquiries"] < api["newInquiries"] and all(c["courseTypeId"] == group_type for c in filtered["courses"]),
          f"{filtered['newInquiries']} of {api['newInquiries']} inquiries")
    m.get_by_label("Course type").select_option(label="All course types")

    # Custom dates: a reversed range is refused on screen and by the API.
    m.get_by_label("Date range").select_option("custom")
    try:
        m.get_by_label("To", exact=True).wait_for(timeout=3000)
    except Exception:  # noqa: BLE001 — the choice landed during a re-render; choose again
        m.get_by_label("Date range").select_option("30")
        m.get_by_label("Date range").select_option("custom")
    m.get_by_label("From", exact=True).fill(today)
    m.get_by_label("To", exact=True).fill(month_ago)
    m.get_by_label("To", exact=True).blur()
    expect(m.get_by_text("Choose a start date on or before the end date.")).to_be_visible()
    expect(m.get_by_text("Sales agents")).to_have_count(0)  # no stale figures under the error
    check("A reversed date range is refused by the API", m.request.get(f"{BASE}/api/reports?from={today}&to={month_ago}").status == 400)
    m.get_by_label("Date range").select_option("30")

    # CSV export.
    with m.expect_download() as dl:
        m.get_by_role("button", name="Download CSV").click()
    path = dl.value.path()
    text = Path(path).read_text(encoding="utf-8-sig")
    rows = list(csv.reader(io.StringIO(text)))
    check("CSV export downloads with the summary, agents and courses", rows[0][0] == "Ammar Academy CRM report" and any(r and r[0] == "Nour Hassan" for r in rows)
          and any(r and r[0] == "New inquiries" and r[1] == str(db_new) for r in rows), dl.value.suggested_filename)

    # Permissions.
    sctx = browser.new_context()
    s = sign_in(sctx, "Nour Hassan", "/my-work")
    check("Sales cannot load reports", s.request.get(f"{BASE}/api/reports?from={month_ago}&to={today}").status == 403)
    s.goto(f"{BASE}/reports")
    check("Sales is sent away from the Reports page", "/reports" not in s.url, s.url)
    uctx = browser.new_context()
    u = sign_in(uctx, "Laila Ibrahim", "/my-work")
    check("Support cannot load reports", u.request.get(f"{BASE}/api/reports?from={month_ago}&to={today}").status == 403)

    # ── 2. Audit history ─────────────────────────────────────────────────
    m.goto(f"{BASE}/settings/audit")
    expect(m.get_by_role("heading", name="Audit History", exact=True)).to_be_visible()
    total = sql("select count(*)::int as n from public.audit_log")[0]["n"]
    m.get_by_placeholder("Search action or record").fill("course")
    m.wait_for_timeout(600)
    shown = m.get_by_role("list", name="Audit entries").get_by_role("listitem").count()
    expected = sql("select count(*)::int as n from public.audit_log where action ilike '%course%' or target ilike '%course%'")[0]["n"]
    check("Audit history search", shown == min(expected, 50) and expected < total, f"{expected} of {total} entries")
    shot(m, "02-audit")
    check("Sales cannot read the audit history", s.request.get(f"{BASE}/api/audit").status == 403)

    # ── 3. Operations ────────────────────────────────────────────────────
    anon = browser.new_context().new_page()
    h = anon.request.get(f"{BASE}/api/health")
    body = h.json()
    check("Health check answers without sign-in and reveals nothing else", h.status == 200 and body["status"] == "ok" and set(body) == {"status", "database", "ms"})
    hdr = anon.request.get(f"{BASE}/login").headers
    check("Security headers on every page", hdr.get("x-frame-options") == "DENY" and "frame-ancestors 'none'" in hdr.get("content-security-policy", "")
          and hdr.get("x-content-type-options") == "nosniff" and "max-age" in hdr.get("strict-transport-security", "") and "x-powered-by" not in hdr)
    check("Scheduler refuses a wrong secret", anon.request.get(f"{BASE}/api/cron/tick", headers={"Authorization": "Bearer wrong-secret-wrong-secret-0000"}).status == 401)

    # Unused receipt clean-up: a day-old orphan goes, a fresh orphan and every linked receipt stay.
    # Baseline run first: earlier test runs may have left genuinely old unused receipts behind.
    anon.request.get(f"{BASE}/api/cron/tick?task=cleanup", headers={"Authorization": f"Bearer {CRON}"})
    linked = [r["p"].replace("receipts/", "") for r in sql("select receipt_path as p from public.payments where receipt_path is not null")]
    old_orphan = RECEIPTS / f"{uuid.uuid4()}.pdf"
    new_orphan = RECEIPTS / f"{uuid.uuid4()}.pdf"
    for f in (old_orphan, new_orphan):
        f.write_bytes(b"%PDF-1.4 synthetic\n")
    two_days = time.time() - 2 * 86400
    os.utime(old_orphan, (two_days, two_days))
    for name in linked:
        os.utime(RECEIPTS / name, (two_days, two_days))  # old but linked: must be kept
    r = anon.request.get(f"{BASE}/api/cron/tick?task=cleanup", headers={"Authorization": f"Bearer {CRON}"})
    res = r.json()["cleanup"]
    check("Clean-up deletes only the unused day-old receipt", res["deleted"] == 1 and not old_orphan.exists() and new_orphan.exists()
          and all((RECEIPTS / n).exists() for n in linked), f"checked {res['checked']}, deleted {res['deleted']}, kept {len(linked)} linked")
    new_orphan.unlink()
    m.goto(f"{BASE}/payments")
    m.get_by_role("tab", name="Confirmed").click()
    m.locator('a[href^="/api/receipts/"]').first.wait_for()
    href = m.locator('a[href^="/api/receipts/"]').first.get_attribute("href")
    check("Linked receipts still open after the clean-up", m.request.get(BASE + href).status == 200)

    # ── 4. Phone layout ──────────────────────────────────────────────────
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Hana Farouk", "/overview")
    for path in ["/reports", "/settings/audit"]:
        mp.goto(f"{BASE}{path}")
        mp.wait_for_load_state("networkidle")
        check(f"{path} fits a phone screen", not mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    mp.goto(f"{BASE}/reports")
    shot(mp, "03-reports-phone")
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
