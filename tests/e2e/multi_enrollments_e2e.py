"""
CRM changes plan 2, Phase 1 browser test (28 Oct 2026): a customer with several enrollments —
support adds a course in another program and credits themselves, the sales agent adds another
course and splits one transfer across both, handover goes to the customer's support owner without
waiting for confirmation, and the accountant reads everything, records a payment (confirmed at once)
and reviews enrollments without being able to change the lead. Synthetic data only.

Runs against the production build and a freshly seeded local database:
  python3 tests/e2e/multi_enrollments_e2e.py [screenshot_dir]
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


MOCKS = "SAT · Mock exam pack (4 tests)"      # 1,800 EGP, another program than Sara's IELTS
SPEAKING = "IELTS · Speaking coaching 1:1"    # 4,000 EGP
course_id = lambda name: sql("select id from public.courses where name = $1", [name])[0]["id"]
person = lambda name: sql("select id from public.profiles where full_name = $1", [name])[0]["id"]
sara = sql("""select i.id as inquiry, c.id as contact from public.inquiries i join public.contacts c on c.id = i.contact_id where c.name = 'Sara Nasser'""")[0]
enrollments = lambda: sql("""select co.name, e.additional, e.original_sales_owner_id as credit, e.review_status, o.support_owner_id as support,
                                    coalesce((select sum(amount) from public.payments p where p.enrollment_id = e.id and p.status in ('pending', 'confirmed')), 0)::float8 as recorded
                               from public.enrollments e join public.courses co on co.id = e.course_id left join public.onboardings o on o.enrollment_id = e.id
                              where e.inquiry_id = $1 order by e.created_at""", [sara["inquiry"]])


def open_payments(page, path="/customers"):
    page.goto(f"{BASE}{path}")
    page.get_by_label("Search customers").fill("Sara")
    page.locator("[data-customer='Sara Nasser']:visible").first.click()
    panel = page.get_by_role("dialog", name="Customer details")
    panel.get_by_role("tab", name="Payments").click()
    return panel


def add_enrollment(page, panel, course, credit=None):
    panel.get_by_role("button", name="Add another enrollment").click()
    d = page.get_by_role("dialog", name="Add another enrollment")
    d.get_by_label("Course").select_option(course_id(course))
    if credit:
        d.get_by_label("Credited to").select_option(person(credit))
    d.get_by_role("button", name="Add enrollment").click()
    expect(page.get_by_text("Another enrollment added")).to_be_visible()
    expect(panel.get_by_role("region", name=f"Enrollment: {course}")).to_be_visible()


with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── 1. Support adds a course in another program and credits themselves ─
    uctx = browser.new_context(viewport={"width": 1440, "height": 900})
    u = sign_in(uctx, "Laila Ibrahim", "/my-work")
    panel = open_payments(u)
    add_enrollment(u, panel, MOCKS, credit="Laila Ibrahim")
    rows = enrollments()
    check("Support adds a course in another program to the same customer, credited to themselves",
          len(rows) == 2 and rows[1]["name"] == MOCKS and rows[1]["additional"] and rows[1]["credit"] == person("Laila Ibrahim")
          and sql("select count(*)::int as n from public.inquiries where contact_id = $1", [sara["contact"]])[0]["n"] == 1, json.dumps(rows))
    shot(u, "01-two-enrollments", full=True)

    # ── 2. The sales agent adds another course and splits one transfer across both ──
    sctx = browser.new_context(viewport={"width": 1440, "height": 900})
    s = sign_in(sctx, "Nour Hassan", "/my-work")
    s.goto(f"{BASE}/leads")
    s.get_by_label("Search by name or phone").fill("Sara")
    s.get_by_text("Sara Nasser", exact=True).first.click()
    spanel = s.get_by_role("dialog", name="Customer details")
    spanel.get_by_role("tab", name="Payments").click()
    add_enrollment(s, spanel, SPEAKING)
    spanel.get_by_role("button", name="Split one transfer").click()
    d = s.get_by_role("dialog", name="Split one transfer")
    d.get_by_label(f"{MOCKS} (EGP)").fill("1800")
    d.get_by_label(f"{SPEAKING} (EGP)").fill("1500")
    expect(d.get_by_test_id("split-total")).to_contain_text("3,300 EGP")
    d.get_by_label("Method").select_option("cash")
    shot(s, "02-split")
    d.get_by_role("button", name="Record split payment").click()
    expect(s.get_by_text("Split payment recorded. A manager or the accountant will confirm it.")).to_be_visible()
    pays = sql("""select co.name, p.amount::float8 as amount, p.status, p.split_group is not null as split, p.kind from public.payments p
                    join public.enrollments e on e.id = p.enrollment_id join public.courses co on co.id = e.course_id
                   where e.inquiry_id = $1 and p.split_group is not null order by co.name""", [sara["inquiry"]])
    check("One transfer is split across two courses, waiting for confirmation",
          [(x["name"], x["amount"], x["status"], x["kind"]) for x in pays] == [(SPEAKING, 1500, "pending", "deposit"), (MOCKS, 1800, "pending", "full")], json.dumps(pays))
    rows = {r["name"]: r for r in enrollments()}
    check("Each course is handed over to the customer's support owner without waiting for confirmation",
          rows[MOCKS]["support"] == person("Laila Ibrahim") and rows[SPEAKING]["support"] == person("Laila Ibrahim"), json.dumps(rows))
    told = sql("select count(*)::int as n from public.notifications where user_id = $1 and text like 'New course for your customer: Sara Nasser%'", [person("Laila Ibrahim")])[0]["n"]
    check("The support owner is told about each new course", told == 2, str(told))

    # ── 3. Support: one Support tab per course ─────────────────────────────
    u.reload()
    panel = open_payments(u)
    panel.get_by_role("tab", name="Support").click()
    course_pick = panel.get_by_label("Course")
    expect(course_pick).to_be_visible()
    check("Support chooses which course's onboarding to work on", course_pick.locator("option").count() == 3)

    # ── 4. The accountant reads everything, records a payment, changes nothing ──
    actx = browser.new_context(viewport={"width": 1440, "height": 900})
    a = sign_in(actx, "Karim Fawzy", "/accounting")
    nav = a.get_by_role("navigation")
    check("The accountant has Leads, Customers, Sessions, Payments and Reports", all(nav.get_by_role("link", name=n).count() for n in ["Leads", "Customers", "Sessions", "Payments", "Reports"]))
    a.goto(f"{BASE}/leads")
    expect(a.get_by_role("heading", name="All leads")).to_be_visible()
    check("The accountant sees every lead, without Add customer or Move leads",
          a.get_by_role("button", name="Add customer").count() == 0 and a.get_by_role("button", name="Move leads").count() == 0)
    apanel = open_payments(a)
    expect(apanel.get_by_text("+971 50 555 0130")).to_be_visible()
    check("The accountant opens the customer record with the phone number but no sales actions",
          apanel.get_by_role("button", name="Record outcome").count() == 0 and apanel.get_by_role("button", name="Add another enrollment").count() == 0
          and apanel.get_by_role("link", name="Call").count() == 0)
    apanel.get_by_role("button", name=f"Record payment for {SPEAKING}").click()
    d = a.get_by_role("dialog", name="Record payment")
    d.get_by_label("Payment type").select_option("full")
    d.get_by_label("Method").select_option("cash")
    d.get_by_role("button", name="Record and confirm").click()
    expect(a.get_by_text("Payment recorded and confirmed.")).to_be_visible()
    last = sql("""select p.status, p.decided_by = p.submitted_by as self from public.payments p join public.enrollments e on e.id = p.enrollment_id
                   join public.courses co on co.id = e.course_id where e.inquiry_id = $1 and co.name = $2 order by p.submitted_at desc limit 1""", [sara["inquiry"], SPEAKING])[0]
    check("The accountant's payment is confirmed at once", last == {"status": "confirmed", "self": True}, json.dumps(last))

    # ── 5. Review: To review in Accounting ─────────────────────────────────
    a.goto(f"{BASE}/accounting?tab=review")
    item = a.locator(f"[data-review-item='Sara Nasser']").filter(has_text=MOCKS)
    expect(item).to_contain_text("Additional enrollment")
    shot(a, "03-review", full=True)
    item.get_by_role("button", name="Reviewed").click()
    expect(a.get_by_text("Marked as reviewed")).to_be_visible()
    a.locator("[data-review-item='Sara Nasser']").filter(has_text=SPEAKING).get_by_role("button", name="Query…").click()
    q = a.get_by_role("dialog", name=f"Query {SPEAKING}")
    q.get_by_label("What needs checking?").fill("Was the 1:1 price agreed with a manager?")
    q.get_by_role("button", name="Send query").click()
    expect(a.get_by_text("Query sent")).to_be_visible()
    rows = {r["name"]: r for r in enrollments()}
    told = sql("select count(*)::int as n from public.notifications where user_id = $1 and text like 'Enrollment queried by Karim Fawzy: Sara Nasser%'", [person("Nour Hassan")])[0]["n"]
    check("Reviews are saved and a query tells the person who entered it", rows[MOCKS]["review_status"] == "reviewed" and rows[SPEAKING]["review_status"] == "queried" and told == 1,
          json.dumps([rows[MOCKS]["review_status"], rows[SPEAKING]["review_status"], told]))
    a.goto(f"{BASE}/accounting?tab=audit")
    expect(a.get_by_text("Queried enrollment: IELTS · Speaking coaching 1:1").first).to_be_visible()
    check("The accountant sees the audit history", True)

    # ── 6. Phone layout ────────────────────────────────────────────────────
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Laila Ibrahim", "/my-work")
    open_payments(mp)
    check("Several enrollments fit a phone", not mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    shot(mp, "04-phone", full=True)
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
