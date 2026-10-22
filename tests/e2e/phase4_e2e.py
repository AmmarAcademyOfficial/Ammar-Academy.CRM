"""
Phase 4 browser test: courses catalog and course filters, enrollment and payment
with a private receipt, manager confirmation → handover → support onboarding,
rejection, reversal with review flag, and permissions on receipts.

Runs against the production build and a freshly seeded local database:
  python3 tests/e2e/phase4_e2e.py [screenshot_dir]
Synthetic data only.
"""
import json
import subprocess
import sys
import tempfile
import zlib
import struct
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


def shot(page, name):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.screenshot(path=str(SHOTS / f"{name}.png"))


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


def png_bytes():
    """A real 8×8 PNG (a receipt photo stand-in)."""
    raw = b"".join(b"\x00" + b"\xf0\x90\x30" * 8 for _ in range(8))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def sign_in(ctx, name, path):
    page = ctx.new_page()
    page.goto(f"{BASE}/login")
    page.get_by_role("button", name=name).click()
    page.wait_for_url(f"**{path}*")
    return page


def leads_total(page, **filters):
    q = json.dumps({"filters": filters, "sort": {"key": "created", "dir": "desc"}, "page": 0, "pageSize": 100})
    return page.request.get(f"{BASE}/api/leads?q={q}").json()["total"]


def open_lead(page, name):
    page.goto(f"{BASE}/leads")
    page.get_by_role("button", name=name).first.click()
    panel = page.get_by_role("dialog", name="Customer details")
    expect(panel).to_be_visible()
    return panel


tmp = Path(tempfile.mkdtemp())
receipt = tmp / "instapay-receipt.png"
receipt.write_bytes(png_bytes())
fake = tmp / "not-really.png"
fake.write_text("this is a text file pretending to be a picture")

courses = {r["name"]: r["id"] for r in sql("select id, name from public.courses")}
types = {r["name"]: r["id"] for r in sql("select id, name from public.course_types")}
P = {r["full_name"].split()[0].lower(): r["id"] for r in sql("select id, full_name from public.profiles")}

with sync_playwright() as p:
    browser = p.chromium.launch()
    mctx = browser.new_context(viewport={"width": 1440, "height": 900})
    m = sign_in(mctx, "Hana Farouk", "/overview")

    # ── 1. Courses catalog ────────────────────────────────────────────────
    m.goto(f"{BASE}/settings/courses")
    expect(m.get_by_text("SAT · December 2026 Intensive")).to_be_visible()
    m.get_by_role("button", name="Add type").click()
    d = m.get_by_role("dialog", name="Add course type")
    d.get_by_label("Name").fill("Weekend group")
    d.get_by_role("button", name="Green").click()
    d.get_by_role("button", name="Save").click()
    expect(m.get_by_text("Course type saved")).to_be_visible()
    m.get_by_role("button", name="Add course").click()
    d = m.get_by_role("dialog", name="Add course")
    d.get_by_label("Course name").fill("SAT · Weekend Group (Jan 2027)")
    d.get_by_label("Course type").select_option(label="Weekend group")
    d.get_by_label("Price").fill("11000")
    d.get_by_label("Sessions").fill("20")
    d.get_by_label("Hours per session").fill("2")
    d.get_by_label("Schedule").fill("Fri & Sat 11 am–1 pm")
    d.get_by_label("Starts").fill("2027-01-08")
    d.get_by_label("Details").fill("Weekend classes for students with a busy school week.")
    d.get_by_role("button", name="Save course").click()
    expect(m.get_by_text("Course added")).to_be_visible()
    row = sql("select price, sessions_count, schedule, course_type_id from public.courses where name = 'SAT · Weekend Group (Jan 2027)'")
    check("Manager adds a course type and a course with price and details", row and float(row[0]["price"]) == 11000 and row[0]["sessions_count"] == 20)
    m.get_by_label("Course type").select_option(label="Weekend group")
    expect(m.get_by_text("SAT · Weekend Group (Jan 2027)")).to_be_visible()
    expect(m.get_by_text("SAT · December 2026 Intensive")).to_have_count(0)
    check("Catalog filters by course type", True)
    m.get_by_label("Course type").select_option(label="All course types")
    shot(m, "01-courses")

    # ── 2. Leads filtered by course and course type ──────────────────────
    check("Leads filter by course type (Intensive)", leads_total(m, courseTypeIds=[types["Intensive"]]) == 2)
    check("Leads filter by course", leads_total(m, courseIds=[courses["IELTS · November 2026 Academic"]]) == 2)
    no_course = leads_total(m, courseIds=["none"])
    check("Leads filter: no course yet", 0 < no_course < 25, f"{no_course}")
    m.goto(f"{BASE}/leads")
    m.get_by_role("button", name="Filters").click()
    fd = m.get_by_role("dialog", name="Filters")
    fd.get_by_label("Intensive", exact=True).check()
    fd.get_by_role("button", name="Show results").click()
    expect(m.get_by_text("Course type: Intensive")).to_be_visible()
    expect(m.get_by_text("2 matching inquiries")).to_be_visible()
    shot(m, "02-leads-course-filter")

    # ── 3. Agent: enrollment and payment with a receipt ──────────────────
    sctx = browser.new_context(viewport={"width": 1440, "height": 900})
    s = sign_in(sctx, "Nour Hassan", "/my-work")
    panel = open_lead(s, "Nadine Wahba")
    panel.get_by_role("tab", name="payments").click()
    panel.get_by_role("button", name="Start enrollment").click()
    d = s.get_by_role("dialog", name="Start enrollment")
    check("Enrollment starts from the lead's course and its price", d.get_by_label("Agreed total (EGP)").input_value() == "8500")
    d.get_by_label("Agreed total (EGP)").fill("8000")
    expect(d.get_by_role("button", name="Save")).to_be_disabled()
    d.get_by_label("Reason for the different price").fill("Sibling discount")
    d.get_by_role("button", name="Save").click()
    expect(s.get_by_text("Enrollment started. The lead is now Awaiting Payment.")).to_be_visible()
    panel.get_by_role("button", name="Record payment").click()
    d = s.get_by_role("dialog", name="Record payment")
    d.get_by_label("Amount (EGP)").fill("2400")
    d.get_by_label("Method").select_option("instapay")
    d.get_by_label("Reference").fill("IPN-E2E-7788")
    d.locator("#receipt-file").set_input_files(str(fake))
    expect(s.get_by_text("Use a JPG, PNG, WebP photo or a PDF.")).to_be_visible()
    check("A file that is not really an image is refused", True)
    d.locator("#receipt-file").set_input_files(str(receipt))
    expect(d.get_by_text("instapay-receipt.png")).to_be_visible()
    shot(s, "03-submit-payment")
    d.get_by_role("button", name="Submit for confirmation").click()
    expect(s.get_by_text("Payment submitted. A manager will confirm it.")).to_be_visible()
    expect(panel.get_by_text("waiting for manager review (not counted yet)")).to_be_visible()
    pay = sql("""select p.id, p.status, p.receipt_mime from public.payments p join public.enrollments e on e.id = p.enrollment_id
                 join public.inquiries i on i.id = e.inquiry_id join public.contacts c on c.id = i.contact_id where c.name = 'Nadine Wahba'""")[0]
    check("Payment saved as pending with a private receipt", pay["status"] == "pending" and pay["receipt_mime"] == "image/png")
    shot(s, "04-panel-payments-pending")

    # ── 4. Receipt permissions ────────────────────────────────────────────
    r = s.request.get(f"{BASE}/api/receipts/{pay['id']}")
    check("The agent can open her own customer's receipt", r.status == 200 and r.headers["content-type"] == "image/png")
    yctx = browser.new_context()
    y = sign_in(yctx, "Youssef Adel", "/my-work")
    check("Another agent cannot open it", y.request.get(f"{BASE}/api/receipts/{pay['id']}").status == 404)
    anon = browser.new_context().new_page()
    check("Signed-out visitors cannot open it", anon.request.get(f"{BASE}/api/receipts/{pay['id']}").status == 401)

    # ── 5. Manager confirms → Enrolled and handed over ───────────────────
    m.goto(f"{BASE}/payments")
    card = m.locator("article").filter(has_text="2,400 EGP")
    expect(card).to_be_visible()
    shot(m, "05-payments-queue")
    r = m.request.get(f"{BASE}/api/receipts/{pay['id']}")
    check("The manager can open the receipt", r.status == 200)
    card.get_by_role("button", name="Confirm").click()
    expect(m.get_by_text("Payment confirmed. The customer is Enrolled and handed over to support.")).to_be_visible()
    st = sql("""select s.system_key, (select count(*)::int from public.onboardings o join public.enrollments e on e.id = o.enrollment_id where e.inquiry_id = i.id) as onb
                from public.inquiries i join public.stages s on s.id = i.stage_id join public.contacts c on c.id = i.contact_id where c.name = 'Nadine Wahba'""")[0]
    check("30% deposit confirmed: stage Enrolled, one onboarding record", st["system_key"] == "enrolled" and st["onb"] == 1)

    # Reject Hoda's pending deposit with a reason.
    hoda_card = m.locator("article").filter(has_text="3,600 EGP")
    hoda_card.get_by_role("button", name="Reject").click()
    d = m.get_by_role("dialog", name="Reject payment")
    expect(d.get_by_role("button", name="Reject")).to_be_disabled()
    d.get_by_label("Reason").fill("Amount does not match the bank transfer")
    d.get_by_role("button", name="Reject").click()
    expect(m.get_by_text("Payment rejected. The agent was told why.")).to_be_visible()
    told = sql("select 1 from public.notifications where user_id = $1 and text like 'Payment rejected%'", [P["nour"]])
    check("Rejection reaches the agent with the reason", len(told) == 1)
    expect(m.get_by_text("Nothing to confirm")).to_be_visible()

    # ── 6. Support: Assign to Me, checklist, Active ──────────────────────
    uctx = browser.new_context(viewport={"width": 1440, "height": 900})
    u = sign_in(uctx, "Laila Ibrahim", "/my-work")
    queue = u.get_by_role("listitem").filter(has_text="Nadine Wahba")
    expect(queue).to_be_visible()
    shot(u, "06-support-queue")
    queue.get_by_role("button", name="Assign to Me").click()
    expect(u.get_by_text("Customer assigned to you")).to_be_visible()
    owner = sql("""select o.support_owner_id, o.status from public.onboardings o join public.enrollments e on e.id = o.enrollment_id
                   join public.inquiries i on i.id = e.inquiry_id join public.contacts c on c.id = i.contact_id where c.name = 'Nadine Wahba'""")[0]
    check("Assign to Me makes Laila the owner and starts onboarding", owner["support_owner_id"] == P["laila"] and owner["status"] == "onboarding")
    u.get_by_role("button", name="Nadine Wahba").first.click()
    sp = u.get_by_role("dialog", name="Customer details")
    expect(sp.get_by_text("Onboarding checklist")).to_be_visible()
    sp.get_by_label("Support status").select_option("active")
    expect(u.get_by_text("Finish the onboarding checklist first.")).to_be_visible()
    check("Active is refused while checklist steps are open", True)
    steps = sp.locator("button[aria-pressed='false']")
    for _ in range(steps.count()):
        sp.locator("button[aria-pressed='false']").first.click()
        u.wait_for_timeout(400)
    expect(sp.get_by_text("5 of 5 done")).to_be_visible()
    sp.get_by_label("Support status").select_option("active")
    expect(u.get_by_text("Support status updated")).to_be_visible()
    sp.get_by_role("button", name="Add", exact=True).click()
    fu = u.get_by_role("dialog", name="Add support follow-up")
    fu.get_by_label("What to do").fill("Ask how the first week went")
    fu.get_by_role("button", name="Save").click()
    expect(u.get_by_text("Follow-up added")).to_be_visible()
    shot(u, "07-support-panel")
    act = sql("""select o.status from public.onboardings o join public.enrollments e on e.id = o.enrollment_id join public.inquiries i on i.id = e.inquiry_id
                 join public.contacts c on c.id = i.contact_id where c.name = 'Nadine Wahba'""")[0]
    check("Customer is Active after the checklist", act["status"] == "active")
    check("Support cannot see sales prospects' receipts", u.request.get(f"{BASE}/api/receipts/{pay['id']}").status == 200
          and u.request.get(f"{BASE}/api/receipts/" + sql("select p.id from public.payments p join public.enrollments e on e.id = p.enrollment_id join public.inquiries i on i.id = e.inquiry_id join public.contacts c on c.id = i.contact_id where c.name = 'Hoda Salem'")[0]["id"]).status == 404)
    check("Support cannot open the payments queue", u.request.get(f"{BASE}/api/payments").status == 403)
    u.goto(f"{BASE}/payments")
    u.wait_for_url("**/my-work*")
    check("Support is redirected away from Payments", "/my-work" in u.url)
    check("Sales cannot open the customers list", s.request.get(f"{BASE}/api/customers").status == 403)

    # ── 7. Reversal flags a handed-over customer ─────────────────────────
    m.goto(f"{BASE}/payments")
    m.get_by_role("tab", name="Confirmed").click()
    sara = m.locator("article").filter(has_text="8,000 EGP")
    sara.get_by_role("button", name="Reverse").click()
    d = m.get_by_role("dialog", name="Reverse confirmed payment")
    d.get_by_label("Reason").fill("Wallet transfer was cancelled")
    d.get_by_role("button", name="Reverse").click()
    expect(m.get_by_text("Payment reversed. The customer is below the handover rule and was flagged for review.")).to_be_visible()
    expect(m.get_by_text("1 handed-over customer flagged after a reversal")).to_be_visible()
    shot(m, "08-payments-flagged")
    m.goto(f"{BASE}/customers")
    m.get_by_label("Flagged for review only").check()
    expect(m.get_by_role("listitem").filter(has_text="Sara Nasser")).to_be_visible()
    check("Flagged customer listed on the Support page", True)
    shot(m, "09-support-flagged")

    # ── 8. Checklist settings and Overview ───────────────────────────────
    m.goto(f"{BASE}/settings/checklist")
    m.get_by_role("button", name="Add step").click()
    d = m.get_by_role("dialog", name="Add step")
    d.get_by_label("Step").fill("Send welcome pack")
    d.get_by_label("Due (days after handover)").fill("3")
    d.get_by_role("button", name="Save").click()
    expect(m.get_by_text("Send welcome pack")).to_be_visible()
    check("Manager adds an onboarding checklist step", len(sql("select 1 from public.checklist_template where label = 'Send welcome pack'")) == 1)
    m.goto(f"{BASE}/overview")
    expect(m.get_by_text("Payments to confirm")).to_be_visible()
    expect(m.get_by_text("1 customer flagged")).to_be_visible()
    shot(m, "10-overview")

    # ── 9. Phone layout ───────────────────────────────────────────────────
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Hana Farouk", "/overview")
    for path in ["/payments", "/customers", "/settings/courses", "/settings/checklist"]:
        mp.goto(f"{BASE}{path}")
        mp.wait_for_load_state("networkidle")
        check(f"{path} fits a phone screen", not mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    mu = sign_in(browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True), "Laila Ibrahim", "/my-work")
    check("Support My Work fits a phone screen", not mu.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
