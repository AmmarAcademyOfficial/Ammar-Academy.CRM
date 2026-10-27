"""
CRM changes, Part D browser test (26 Oct 2026): Add existing customer — a manager adds a new
customer with a past payment and a plan; support adds an enrollment to someone already in the CRM
(phone match), whose payment goes to review; checks and the phone layout. Synthetic data only.

Runs against the production build and a freshly seeded local database:
  python3 tests/e2e/existing_customer_e2e.py [screenshot_dir]
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


today = datetime.now(ZoneInfo("Africa/Cairo")).date()
past = (today - timedelta(days=40)).isoformat()
paid_on = (today - timedelta(days=39)).isoformat()
due_on = (today + timedelta(days=20)).isoformat()
IELTS_COURSE = "IELTS · November 2026 Academic"   # 8,500 EGP
SAT_COURSE = "SAT · Mock exam pack (4 tests)"     # 1,800 EGP
sara = sql("""select c.phone_normalized as phone, c.id from public.contacts c where c.name = 'Sara Nasser'""")[0]

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── 1. Manager: a new existing customer, a confirmed past payment and a plan ──
    mctx = browser.new_context(viewport={"width": 1440, "height": 900})
    m = sign_in(mctx, "Hana Farouk", "/overview")
    m.goto(f"{BASE}/customers")
    m.get_by_role("button", name="Add existing customer").click()
    d = m.get_by_role("dialog", name="Add existing customer")
    d.get_by_label("Phone").fill("0109 777 2211")
    d.get_by_label("Student name").click()  # leaves the phone field: checked against the CRM
    expect(d.get_by_test_id("phone-match")).to_have_count(0)
    d.get_by_label("Customer name").fill("Rania Fathy")
    d.get_by_label("Student name").fill("Malak")
    d.get_by_label("Program").select_option(label="IELTS")
    d.get_by_label("Course").select_option(label=IELTS_COURSE)
    expect(d.get_by_label("Agreed total (EGP)")).to_have_value("8500")
    d.get_by_label("Enrolled on").fill(past)
    d.get_by_label("Sales agent credited").select_option(label="Mariam Samir")
    d.get_by_label("Support owner").select_option(label="Laila Ibrahim")
    d.get_by_role("button", name="Add a payment").click()
    d.get_by_label("Payment 1 amount", exact=True).fill("3000")
    d.get_by_label("Payment 1 date paid", exact=True).fill(paid_on)
    d.get_by_label("Payment 1 method", exact=True).select_option("cash")
    expect(d.get_by_test_id("paid-summary")).to_contain_text("5,500 EGP left")
    d.get_by_role("button", name="Add a planned payment").click()
    d.get_by_label("Planned payment 1 due date").fill(due_on)
    expect(d.get_by_label("Planned payment 1 amount")).to_have_value("5500")
    shot(m, "01-add-existing", full=True)

    d.get_by_label("Payment 1 amount", exact=True).fill("9000")
    expect(d.get_by_test_id("add-existing-hint")).to_have_text("The payments add up to more than the agreed total.")
    expect(d.get_by_role("button", name="Add customer")).to_be_disabled()
    check("The form checks totals before saving", True)
    d.get_by_label("Payment 1 amount", exact=True).fill("3000")
    d.get_by_label("Planned payment 1 amount").fill("5500")
    d.get_by_role("button", name="Add customer").click()
    expect(m.get_by_text("Customer added", exact=True)).to_be_visible()
    expect(m.get_by_role("dialog", name="Customer details")).to_be_visible()
    check("Saving opens the new customer's record", True)

    row = sql("""select i.added_as_existing, s.system_key as stage, e.original_sales_owner_id = (select id from public.profiles where full_name = 'Mariam Samir') as credited,
                        o.support_owner_id = (select id from public.profiles where full_name = 'Laila Ibrahim') as laila,
                        (select string_agg(status::text, ',') from public.payments where enrollment_id = e.id) as payments,
                        (select count(*)::int from public.payment_dues where enrollment_id = e.id) as dues,
                        to_char(e.created_at at time zone 'Africa/Cairo', 'YYYY-MM-DD') as enrolled
                   from public.contacts c join public.inquiries i on i.contact_id = c.id join public.stages s on s.id = i.stage_id
                   join public.enrollments e on e.inquiry_id = i.id join public.onboardings o on o.enrollment_id = e.id
                  where c.name = 'Rania Fathy'""")
    check("A manager's entry is saved in one step: enrolled, credited, with support, payment confirmed, plan set",
          row and row[0] == {"added_as_existing": True, "stage": "enrolled", "credited": True, "laila": True, "payments": "confirmed", "dues": 1, "enrolled": past}, json.dumps(row))
    nl = sql("select count(*)::int as n from public.notifications where kind = 'new_lead' and text like '%Rania Fathy%'")[0]["n"]
    check("No new-lead alerts for an existing customer", nl == 0)
    m.keyboard.press("Escape")
    m.get_by_label("Search customers").fill("Rania")
    expect(m.locator("tbody tr[data-customer='Rania Fathy']")).to_contain_text("5,500 EGP")
    check("The customer list shows them with the right balance", True)

    # ── 2. Support: someone already in the CRM; the payment goes to review ──
    uctx = browser.new_context(viewport={"width": 1440, "height": 900})
    u = sign_in(uctx, "Laila Ibrahim", "/my-work")
    u.goto(f"{BASE}/customers")
    u.get_by_role("button", name="Add existing customer").click()
    d = u.get_by_role("dialog", name="Add existing customer")
    d.get_by_label("Phone").fill(sara["phone"])
    d.get_by_label("Student name").click()
    expect(d.get_by_test_id("phone-match")).to_contain_text("Already in the CRM: Sara Nasser")
    expect(d.get_by_label("Customer name")).to_have_count(0)
    check("A known phone is matched, so the person is not entered twice", True)
    d.get_by_label("Program").select_option(label="SAT")
    d.get_by_label("Course").select_option(label=SAT_COURSE)
    d.get_by_role("button", name="Add a payment").click()
    d.get_by_label("Payment 1 amount", exact=True).fill("1800")
    d.get_by_label("Payment 1 type", exact=True).select_option("full")
    d.get_by_role("button", name="Add customer").click()
    expect(u.get_by_text("Customer added. The past payments are waiting for a manager or the accountant to confirm.")).to_be_visible()
    rows = sql("""select count(*)::int as n, string_agg(p.status::text, ',') as pay from public.inquiries i join public.enrollments e on e.inquiry_id = i.id
                  left join public.payments p on p.enrollment_id = e.id where i.contact_id = $1 and i.added_as_existing""", [sara["id"]])[0]
    check("Support adds the enrollment to the existing person; their payment waits for review", rows == {"n": 1, "pay": "pending"}, json.dumps(rows))
    shot(u, "02-support-added")

    # ── 3. Sales cannot; phone layout ───────────────────────────────────────
    sctx = browser.new_context(viewport={"width": 1440, "height": 900})
    s = sign_in(sctx, "Nour Hassan", "/my-work")
    s.goto(f"{BASE}/customers")
    check("Sales agents cannot open the customer page", "/customers" not in s.url, s.url)
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Laila Ibrahim", "/my-work")
    mp.goto(f"{BASE}/customers")
    mp.get_by_role("button", name="Add existing customer").click()
    mp.get_by_role("dialog", name="Add existing customer").get_by_role("button", name="Add a payment").click()
    check("The form fits a phone", not mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    shot(mp, "03-phone", full=True)
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
