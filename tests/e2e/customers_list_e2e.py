"""
CRM changes, Part B browser test (26 Oct 2026): the customer (Enrollments) list — filters that
combine, chips, sorting, totals, remembered filters, what support, managers and the accountant see,
and the phone layout. Expected numbers are counted straight from the database. Synthetic data only.

Runs against the production build and a freshly seeded local database:
  python3 tests/e2e/customers_list_e2e.py [screenshot_dir]
"""
import json
import subprocess
import sys
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


# Independent counts, straight from the tables.
BASE_SQL = """
  from public.enrollments e join public.inquiries i on i.id = e.inquiry_id join public.contacts c on c.id = i.contact_id
  join public.programs p on p.id = i.program_id left join public.onboardings o on o.enrollment_id = e.id
  left join (select enrollment_id, sum(amount) filter (where status = 'confirmed') as paid from public.payments group by enrollment_id) x on x.enrollment_id = e.id
"""
count = lambda where="true", params=None: sql(f"select count(*)::int as n {BASE_SQL} where {where}", params)[0]["n"]
ALL = count()
SAT_BALANCE = count("p.code = 'SAT' and e.agreed_total > coalesce(x.paid, 0)")
SAT = count("p.code = 'SAT'")
TOP_BALANCE = sql(f"select c.name, e.agreed_total - coalesce(x.paid, 0) as b {BASE_SQL} order by b desc, e.created_at desc limit 1")[0]["name"]
laila = sql("select id from public.profiles where full_name = 'Laila Ibrahim'")[0]["id"]
LAILA_VIEW = count("(o.support_owner_id = $1 or (o.id is not null and o.support_owner_id is null))", [laila])

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── 1. Manager: every customer, filters that combine, chips, sort ───────
    mctx = browser.new_context(viewport={"width": 1440, "height": 900})
    m = sign_in(mctx, "Hana Farouk", "/overview")
    m.goto(f"{BASE}/customers")
    rows = m.get_by_role("table", name="Customers").locator("tbody tr")
    expect(rows).to_have_count(min(ALL, 50))
    expect(m.get_by_test_id("enrollment-totals")).to_contain_text("Balance left")
    check("Managers see every enrolled customer with totals per currency", True, f"{ALL} customers")

    m.get_by_role("button", name="Filters").click()
    d = m.get_by_role("dialog", name="Filter customers")
    d.get_by_label("SAT", exact=True).check()
    d.get_by_label("Balance left").check()
    d.get_by_role("button", name="Show customers").click()
    expect(m.get_by_test_id("enrollment-count")).to_have_text(f"{SAT_BALANCE} matching")
    check("Two filters combine: program SAT and balance left", True, f"{SAT_BALANCE} of {SAT} SAT customers")
    shot(m, "01-filters")
    m.get_by_role("button", name="Remove filter Payments: Balance left").click()
    expect(m.get_by_test_id("enrollment-count")).to_have_text(f"{SAT} matching")
    check("Removing a chip widens the list again", True)

    m.get_by_role("button", name="Clear filters").first.click()
    m.get_by_role("button", name="Balance", exact=True).click()
    expect(rows.first).to_have_attribute("data-customer", TOP_BALANCE)
    check("Sorting by balance puts the largest balance first", True, TOP_BALANCE)

    # Remembered filters in this browser.
    m.get_by_role("button", name="Filters").click()
    m.get_by_role("dialog", name="Filter customers").get_by_label("SAT", exact=True).check()
    m.get_by_role("dialog", name="Filter customers").get_by_role("button", name="Show customers").click()
    m.reload()
    expect(m.get_by_test_id("enrollment-count")).to_have_text(f"{SAT} matching")
    check("The last filters are remembered after a reload", True)

    # ── 2. Support: own customers and the queue by default, all on request ──
    uctx = browser.new_context(viewport={"width": 1440, "height": 900})
    u = sign_in(uctx, "Laila Ibrahim", "/my-work")
    u.goto(f"{BASE}/customers")
    urows = u.get_by_role("table", name="Customers").locator("tbody tr")
    expect(urows).to_have_count(min(LAILA_VIEW, 50))
    u.get_by_role("tab", name="All customers").click()
    expect(urows).to_have_count(min(ALL, 50))
    check("Support sees their customers and the queue, or every customer", True, f"{LAILA_VIEW} then {ALL}")
    u.get_by_role("tab", name="Mine and the queue").click()
    u.get_by_label("Search customers").fill("Sara")
    expect(u.locator("tbody tr[data-customer='Sara Nasser']")).to_have_count(1)
    u.locator("tbody tr[data-customer='Sara Nasser']").click()
    expect(u.get_by_role("dialog", name="Customer details")).to_be_visible()
    check("Clicking a customer opens their full record", True)

    # ── 3. Accountant: the same list in Accounting, no phone numbers ────────
    actx = browser.new_context(viewport={"width": 1440, "height": 900})
    a = sign_in(actx, "Karim Fawzy", "/accounting")
    a.goto(f"{BASE}/accounting?tab=customers")
    arows = a.get_by_role("table", name="Customers").locator("tbody tr")
    expect(arows).to_have_count(min(ALL, 50))
    phones = a.get_by_role("table", name="Customers").locator("text=/\\+20/").count()
    check("Accounting → Customers is the same list, without phone numbers", phones == 0)

    # ── 4. Sales cannot; phone layout ───────────────────────────────────────
    sctx = browser.new_context(viewport={"width": 1440, "height": 900})
    s = sign_in(sctx, "Nour Hassan", "/my-work")
    q = json.dumps({"filters": {}, "sort": {"key": "enrolled", "dir": "desc"}, "page": 0, "pageSize": 50})
    check("Sales agents cannot read the customer list", s.request.get(f"{BASE}/api/enrollments?q={q}").status == 403)
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Laila Ibrahim", "/my-work")
    mp.goto(f"{BASE}/customers")
    expect(mp.get_by_role("list", name="Customers").locator("li").first).to_be_visible()
    check("The customer list fits a phone", not mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    shot(mp, "02-phone")
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
