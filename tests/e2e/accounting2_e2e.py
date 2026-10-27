"""
Accounting plan, phase 2 browser test (22 Oct 2026): the Accounting section for managers and the
accountant role. Every figure on screen is checked against the database.

Runs against the production build and a freshly seeded local database:
  python3 tests/e2e/accounting2_e2e.py [screenshot_dir]
Synthetic data only.
"""
import csv
import io
import json
import re
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
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


def egp(n):
    n = float(n)
    s = f"{n:,.2f}".rstrip("0").rstrip(".")
    return f"{s} EGP"


def academy_month(d: date):
    end_y, end_m = (d.year, d.month + 1) if d.day >= 26 else (d.year, d.month)
    if end_m == 13:
        end_y, end_m = end_y + 1, 1
    start_y, start_m = (end_y, end_m - 1) if end_m > 1 else (end_y - 1, 12)
    return date(start_y, start_m, 26), min(date(end_y, end_m, 25), d)


today = datetime.now(ZoneInfo("Africa/Cairo")).date()
a_from, a_to = academy_month(today)
karim, hana = [sql("select id from public.profiles where full_name = $1", [n])[0]["id"] for n in ("Karim Fawzy", "Hana Farouk")]
confirmed_sum = lambda extra="", params=None: float(sql(f"""
    select coalesce(sum(p.amount), 0)::float8 as s from public.payments p join public.enrollments e on e.id = p.enrollment_id
    join public.inquiries i on i.id = e.inquiry_id join public.programs pr on pr.id = i.program_id
    where p.status = 'confirmed' and p.paid_on between $1 and $2 {extra}""", [a_from.isoformat(), a_to.isoformat()] + (params or []))[0]["s"])
owed_total = float(sql("""select coalesce(sum(greatest(e.agreed_total - coalesce((select sum(x.amount) from public.payments x where x.enrollment_id = e.id and x.status = 'confirmed'), 0), 0)), 0)::float8 as s
                          from public.enrollments e""")[0]["s"])

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── 1. Manager: Overview ────────────────────────────────────────────────
    mctx = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
    m = sign_in(mctx, "Hana Farouk", "/overview")
    m.get_by_role("link", name="Accounting").first.click()
    m.wait_for_url("**/accounting")
    expect(m.get_by_role("heading", name="Accounting")).to_be_visible()
    mon = lambda d: d.strftime("%b").replace("Sep", "Sept")  # the app writes dates the British way
    expect(m.get_by_test_id("range")).to_have_text(f"{a_from.day} {mon(a_from)} {a_from.year} – {a_to.day} {mon(a_to)} {a_to.year}")
    check("Accounting opens on this Academy month (26th to 25th)", True, f"{a_from} to {a_to}")
    total = confirmed_sum()
    expect(m.get_by_test_id("money-in")).to_have_text(egp(total))
    check("Money in matches the confirmed payments in the database", True, egp(total))
    expect(m.get_by_test_id("still-owed")).to_have_text(egp(owed_total))
    check("Still owed matches every customer's balance", True, egp(owed_total))
    expect(m.get_by_test_id("overdue")).to_have_text("5,000 EGP")
    check("Overdue planned payments are totalled", True)
    shot(m, "01-overview", full=True)

    # Filters: SAT only.
    m.get_by_label("Program", exact=True).select_option(label="SAT")
    sat = confirmed_sum("and pr.code = $3", ["SAT"])
    expect(m.get_by_test_id("money-in")).to_have_text(egp(sat))
    check("The program filter changes the totals", True, egp(sat))
    m.get_by_role("button", name=re.compile(r"^Clear \d filter")).click()

    # ── 2. Payments tab ─────────────────────────────────────────────────────
    m.get_by_role("tab", name="Payments").click()
    rows = m.get_by_role("table", name="Payments").locator("tbody tr")
    n_conf = sql("select count(*)::int as n from public.payments where status = 'confirmed' and paid_on between $1 and $2", [a_from.isoformat(), a_to.isoformat()])[0]["n"]
    expect(rows).to_have_count(n_conf)
    check("The payments table lists the confirmed payments in the period", True, f"{n_conf} rows")
    review = m.get_by_text("Open the receipt, then confirm or reject.", exact=False).first
    expect(review).to_be_visible()
    expect(m.locator("article").filter(has_text="3,600 EGP")).to_have_count(1)
    check("Payments waiting for review are shown with their receipts", True)
    with m.expect_download() as dl:
        m.get_by_role("button", name="Download CSV").click()
    text = Path(dl.value.path()).read_text(encoding="utf-8-sig")
    lines = list(csv.reader(io.StringIO(text)))
    check("Payments download as CSV", lines[0][:3] == ["Paid on", "Customer", "Student"] and len(lines) == n_conf + 1, f"{len(lines) - 1} rows")
    check("The CSV has no phone numbers", not re.search(r"\+20\d{6,}", text))

    # ── 3. Customers tab ────────────────────────────────────────────────────
    m.get_by_role("tab", name="Customers").click()
    m.get_by_role("button", name="Filters").click()
    m.get_by_role("dialog", name="Filter customers").get_by_label("Overdue").check()
    m.get_by_role("dialog", name="Filter customers").get_by_role("button", name="Show customers").click()
    crow = m.get_by_role("table", name="Customers").locator("tbody tr")
    expect(crow).to_have_count(1)
    expect(crow.first).to_have_attribute("data-customer", "Jana Ezzat")
    expect(crow.first).to_contain_text("10,500 EGP")
    check("Customers: balance left and the overdue filter", True)
    shot(m, "02-customers")
    crow.first.click()
    expect(m.get_by_role("dialog", name="Customer details")).to_be_visible()
    check("A manager can open the customer from Accounting", True)
    m.keyboard.press("Escape")

    # ── 4. Sales agents tab ─────────────────────────────────────────────────
    m.get_by_role("tab", name="Sales agents").click()
    youssef_total = float(sql("""select coalesce(sum(p.amount), 0)::float8 as s from public.payments p join public.enrollments e on e.id = p.enrollment_id
                                 join public.profiles pr on pr.id = e.original_sales_owner_id
                                 where p.status = 'confirmed' and p.paid_on between $1 and $2 and pr.full_name = 'Youssef Adel'""", [a_from.isoformat(), a_to.isoformat()])[0]["s"])
    yrow = m.get_by_role("table", name="Sales agents").locator("tr[data-agent='Youssef Adel']")
    expect(yrow).to_contain_text(egp(youssef_total))
    check("Sales agents: totals credited to the agent who made the sale", True, egp(youssef_total))
    expect(m.get_by_role("table", name="Per agent, per day")).to_be_visible()
    check("Per agent, per day breakdown is shown", True)
    shot(m, "03-agents")

    # ── 5. The accountant ───────────────────────────────────────────────────
    actx = browser.new_context(viewport={"width": 1440, "height": 900})
    a = sign_in(actx, "Karim Fawzy", "/accounting")
    nav = [x.inner_text() for x in a.get_by_role("navigation", name="Main").first.get_by_role("link").all()]
    check("The accountant's menu is Accounting only", nav == ["Accounting"], str(nav))
    a.goto(f"{BASE}/leads")
    a.wait_for_url("**/accounting")
    check("Other pages send the accountant back to Accounting", True)
    leads = a.request.get(f'{BASE}/api/leads?q={json.dumps({"filters": {}})}')
    body = leads.json() if leads.ok else {}
    check("The accountant gets no leads", leads.status in (400, 403) or body.get("total", 0) == 0, f"status {leads.status}")
    expect(a.get_by_test_id("money-in")).to_have_text(egp(total))
    check("The accountant sees the same totals", True)
    page_text = a.locator("main").inner_text()
    check("No phone numbers on the accountant's screens", not re.search(r"\+20 ?\d", page_text))

    # Bell: payment to review → Accounting payments.
    a.get_by_role("button", name=re.compile("^Notifications")).click()
    a.get_by_role("button", name=re.compile("Payment to review: Hoda Salem")).first.click()
    a.wait_for_url("**/accounting?tab=payments")
    check("A payment-to-review notification takes the accountant to the payments", True)
    a.reload()
    card = a.locator("article").filter(has_text="3,600 EGP").first
    receipt = card.get_by_role("link")
    href = receipt.get_attribute("href")
    check("The accountant can open the receipt", a.request.get(f"{BASE}{href}").status == 200)
    card.get_by_role("button", name="Confirm").click()
    expect(a.get_by_text("Payment confirmed").first).to_be_visible()
    pay = sql("""select p.status, p.decided_by from public.payments p join public.enrollments e on e.id = p.enrollment_id
                 join public.inquiries i on i.id = e.inquiry_id join public.contacts c on c.id = i.contact_id
                 where c.name = 'Hoda Salem' and p.amount = 3600""")[0]
    check("The accountant confirms a payment", pay == {"status": "confirmed", "decided_by": karim}, str(pay))
    shot(a, "04-accountant")

    # Manager: give someone the accountant role in Settings.
    m.goto(f"{BASE}/settings/users")
    expect(m.get_by_label("Role for Karim Fawzy")).to_have_value("accountant")
    check("Settings show the Accountant role", m.get_by_label("Role for Nour Hassan").locator("option[value=accountant]").count() == 1)

    # ── 6. Phone layout ─────────────────────────────────────────────────────
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Karim Fawzy", "/accounting")
    mp.wait_for_load_state("networkidle")
    for t in ["Overview", "Payments", "Customers", "Sales agents"]:
        mp.get_by_role("tab", name=t).click()
        mp.wait_for_timeout(300)
        if mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"):
            check(f"Accounting {t} fits a phone", False)
    check("Every Accounting tab fits a phone (wide tables scroll inside their card)", True)
    shot(mp, "05-phone")
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
