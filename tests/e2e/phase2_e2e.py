"""
Phase 2 browser test: the real app (next start) against the seeded local
database, signed in as different staff through local sign-in.

  npm run db:local            # terminal 1
  npm run build && AUTH_MODE=local DATABASE_URL=... npm start   # terminal 2
  python3 tests/e2e/phase2_e2e.py [screenshot_dir]

Synthetic data only. Exits non-zero on the first failed check.
"""
import json
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = "http://localhost:3000"
SHOTS = Path(sys.argv[1]) if len(sys.argv) > 1 else None
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""))
    if not cond:
        raise SystemExit(1)


def shot(page, name):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(600)
        page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=False)


def db_value(query):
    """Reads one value from the local test database (node + pg, already installed)."""
    js = "const pg=require('pg');const c=new pg.Client(process.env.DATABASE_URL||'postgres://postgres:postgres@localhost:54329/crm');" \
         "c.connect().then(()=>c.query(process.argv[1])).then(r=>{process.stdout.write(String(Object.values(r.rows[0])[0]));return c.end()})"
    return subprocess.run(["node", "-e", js, query], capture_output=True, text=True, check=True, cwd=Path(__file__).parents[2]).stdout


def leads_query(**filters):
    q = {"filters": filters, "sort": {"key": "created", "dir": "desc"}, "page": 0, "pageSize": 100}
    return f"{BASE}/api/leads?q=" + urllib.parse.quote(json.dumps(q))


def sign_in(ctx, name, expect_path):
    page = ctx.new_page()
    page.goto(f"{BASE}/login")
    page.get_by_role("button", name=name).click()
    page.wait_for_url(f"**{expect_path}*")
    return page


def api(page, url):
    r = page.request.get(url)
    return r.status, (r.json() if r.headers.get("content-type", "").startswith("application/json") else None)


with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── Manager ──────────────────────────────────────────
    mctx = browser.new_context(viewport={"width": 1440, "height": 900})
    m = sign_in(mctx, "Hana Farouk", "/overview")
    check("Manager lands on Overview", "/overview" in m.url)
    expect(m.get_by_role("heading", name="Overview")).to_be_visible()
    shot(m, "01-manager-overview")

    status, body = api(m, leads_query())
    check("Manager sees all 25 inquiries", status == 200 and body["total"] == 25, f"total={body and body['total']}")
    all_rows = body["rows"]
    by_name = {}
    for r in all_rows:
        by_name.setdefault(r["contact"]["name"], r)
    youssef_lead = by_name["Tarek Nabil"]["inquiry"]["id"]   # owned by Youssef
    nour_lead = by_name["Omar Farid"]["inquiry"]["id"]       # owned by Nour

    status, body = api(m, leads_query(ownerIds=["unassigned"]))
    check("Unassigned filter finds the 3 waiting inquiries", body["total"] == 3, f"total={body['total']}")
    status, body = api(m, leads_query(search="0102 555"))
    check("Phone search with spaces matches", body["total"] >= 3, f"total={body['total']}")
    status, body = api(m, leads_query(search="+20 102 555 0103"))
    check("Search by international format finds the parent with two inquiries", body["total"] == 2, f"total={body['total']}")
    status, body = api(m, leads_query(followUp="overdue"))
    check("Overdue follow-up filter", body["total"] == 4, f"total={body['total']}")
    today = time.strftime("%Y-%m-%d")
    status, body = api(m, leads_query(dateField="created", dateFrom=today, dateTo=today))
    check("Custom date filter (created today) runs on the server", status == 200 and 0 < body["total"] < 25, f"total={body['total']}")

    m.goto(f"{BASE}/leads")
    expect(m.get_by_role("button", name="Omar Farid").first).to_be_visible()
    shot(m, "02-manager-all-leads")

    # Manager writes a note on Nour's lead through the UI; it must survive a reload.
    m.get_by_role("button", name="Omar Farid").first.click()
    panel = m.get_by_role("dialog")
    expect(panel).to_be_visible()
    panel.get_by_role("tab", name="Activity").click()
    note = f"Manager check-in {int(time.time())} — اتصلت بالأب"
    panel.get_by_role("textbox").first.fill(note)
    panel.get_by_role("button", name="Add note").last.click()
    expect(panel.get_by_text(note)).to_be_visible()
    shot(m, "03-lead-panel-note")
    m.reload()
    status, detail = api(m, f"{BASE}/api/leads/{nour_lead}")
    notes = [a for a in detail["activities"] if a["type"] == "comment"]
    check("Note is stored in the database (survives reload)", any(note in (a.get("body") or "") for a in notes))

    # ── Sales: Nour ──────────────────────────────────────
    sctx = browser.new_context(viewport={"width": 1440, "height": 900})
    s = sign_in(sctx, "Nour Hassan", "/my-work")
    check("Sales lands on My Work", "/my-work" in s.url)
    expect(s.get_by_text("Overdue").first).to_be_visible()
    shot(s, "04-sales-my-work")

    status, body = api(s, leads_query())
    owners = {r["inquiry"]["salesOwnerId"] for r in body["rows"]}
    check("Sales sees only her own 12 inquiries", body["total"] == 12 and len(owners) == 1, f"total={body['total']}")
    status, body = api(s, leads_query(ownerIds=["unassigned"]))
    check("Sales owner filter cannot reveal unassigned inquiries", body["total"] == 0, f"total={body['total']}")
    status, detail = api(s, f"{BASE}/api/leads/{youssef_lead}")
    check("Sales cannot open another agent's inquiry by ID", detail is None or status in (403, 404), f"status={status}")
    status, detail = api(s, f"{BASE}/api/leads/{nour_lead}")
    check("Sales sees the manager's note on her own inquiry", status == 200 and any(note in (a.get("body") or "") for a in detail["activities"]))

    s.goto(f"{BASE}/overview")
    s.wait_for_url("**/my-work*")
    check("Sales is redirected away from the manager Overview", "/my-work" in s.url)
    s.goto(f"{BASE}/settings")
    s.wait_for_url("**/my-work*")
    check("Sales is redirected away from Settings", "/my-work" in s.url)
    status, _ = api(s, f"{BASE}/api/overview")
    check("Overview API refuses sales", status == 403, f"status={status}")

    # Sales records an outcome through the UI.
    s.goto(f"{BASE}/leads")
    s.get_by_role("button", name="Adam Wael").first.click()
    panel = s.get_by_role("dialog")
    panel.get_by_role("button", name="Record outcome").click()
    dlg = s.get_by_role("dialog", name="Record contact attempt")
    dlg.get_by_label("Reached", exact=True).check()
    dlg.get_by_role("button", name="Save outcome").click()
    expect(s.get_by_text("Contact attempt recorded").first).to_be_visible()
    shot(s, "05-sales-outcome-recorded")
    reached_id = db_value("select id from public.contact_outcomes where system_key = 'reached'")
    status, body = api(s, leads_query(search="Adam Wael"))
    check("Outcome saved to the database", body["rows"][0]["inquiry"].get("lastOutcomeId") == reached_id)

    # ── Support ──────────────────────────────────────────
    uctx = browser.new_context(viewport={"width": 1440, "height": 900})
    u = sign_in(uctx, "Laila Ibrahim", "/my-work")
    status, body = api(u, leads_query())
    # Since Phase 4 support sees handed-over (Enrolled) customers, never open sales prospects.
    ps, pb = api(u, leads_query(stageKeys=["new", "contacting", "qualified", "awaiting_payment", "lost", "invalid"]))
    check("Support sees no sales pipeline inquiries (only handed-over customers)", status == 403 or (status == 200 and ps == 200 and pb["total"] == 0), f"status={status} prospects={pb and pb.get('total')}")
    shot(u, "06-support-home")

    # ── Signed out ───────────────────────────────────────
    s.goto(f"{BASE}/my-work")
    s.get_by_role("button", name="Sign out", exact=True).click()
    s.wait_for_url("**/login*")
    status = s.request.get(leads_query()).status
    check("Sign out ends the session (API refuses afterwards)", status == 401, f"status={status}")
    s.goto(f"{BASE}/leads")
    check("Signed-out visit to Leads goes to the sign-in page", "/login" in s.url)
    octx = browser.new_context()
    o = octx.new_page()
    status = o.request.get(leads_query()).status
    check("Signed-out API request is refused", status == 401, f"status={status}")

    # ── Mobile ───────────────────────────────────────────
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Nour Hassan", "/my-work")
    overflow = mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")
    check("My Work fits a phone screen (no sideways scroll)", not overflow)
    shot(mp, "07-sales-mobile")

    browser.close()

print(f"\n{sum(ok for _, ok, _ in results)}/{len(results)} checks passed")
