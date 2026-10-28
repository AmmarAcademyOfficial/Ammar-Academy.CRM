"""
CRM changes plan 3, release 4 browser test (28 Oct 2026): support requests a refund, the accountant
records it from To review (Keep studying: the agreed total drops), a manager records a Withdraw refund
(the plan is cancelled and the course ends), a request is declined, and refunds show on the course
card, in Accounting (Overview, Payments) and in the Customers list. Synthetic data only.

Runs against the production build and a freshly seeded local database:
  python3 tests/e2e/refunds_e2e.py [screenshot_dir]
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


def open_customer(page, name):
    page.goto(f"{BASE}/customers")
    page.get_by_label("Search customers").fill(name.split()[0])
    page.locator(f"[data-customer='{name}']:visible").first.click()
    panel = page.get_by_role("dialog", name="Customer details")
    expect(panel.get_by_role("tab", name="Payments")).to_be_visible()
    page.wait_for_timeout(500)  # the panel slides in
    panel.get_by_role("tab", name="Payments").click()
    return panel


def open_lead(page, name):
    page.goto(f"{BASE}/leads")
    page.get_by_label("Search by name or phone").fill(name.split()[0])
    page.get_by_text(name, exact=True).first.click()
    panel = page.get_by_role("dialog", name="Customer details")
    expect(panel.get_by_role("button", name="More actions")).to_be_visible()
    page.wait_for_timeout(500)
    return panel


def lead_id(name):
    return sql("select i.id from public.inquiries i join public.contacts c on c.id = i.contact_id where c.name = $1", [name])[0]["id"]


sara = lead_id("Sara Nasser")
jana = lead_id("Jana Ezzat")
enr = lambda inquiry: sql("select id, agreed_total::float8 as agreed, withdrawn_at from public.enrollments where inquiry_id = $1", [inquiry])[0]
refunds = lambda inquiry: sql("""select r.status, r.amount::float8 as amount, r.outcome from public.refunds r join public.enrollments e on e.id = r.enrollment_id
                                 where e.inquiry_id = $1 order by r.created_at""", [inquiry])
person = lambda name: sql("select id from public.profiles where full_name = $1", [name])[0]["id"]
told = lambda name, like: sql("select count(*)::int as n from public.notifications where user_id = $1 and text like $2", [person(name), like])[0]["n"]

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── 1. Support asks for a refund ───────────────────────────────────────
    uctx = browser.new_context(viewport={"width": 1440, "height": 900})
    u = sign_in(uctx, "Laila Ibrahim", "/my-work")
    panel = open_customer(u, "Sara Nasser")
    panel.get_by_role("button", name="Request refund").click()
    d = u.get_by_role("dialog", name="Request refund")
    d.get_by_label("Amount (EGP)").fill("9000")
    expect(d.get_by_text("More than the 8,000 EGP confirmed")).to_be_visible()
    d.get_by_label("Amount (EGP)").fill("1000")
    d.get_by_label("Reason").select_option("goodwill")
    d.get_by_label("Note (optional)").fill("Early-bird discount agreed late")
    d.get_by_role("button", name="Request refund").click()
    expect(u.get_by_text("Refund requested. A manager or the accountant will decide.")).to_be_visible()
    expect(panel.get_by_text("Refund of 1,000 EGP requested · Goodwill or discount")).to_be_visible()
    check("Support requests a refund; nothing counts yet", refunds(sara) == [{"status": "requested", "amount": 1000, "outcome": None}] and enr(sara)["agreed"] == 8000)
    check("The accountant and managers are told", told("Karim Fawzy", "Refund requested: Sara Nasser%") == 1 and told("Hana Farouk", "Refund requested: Sara Nasser%") == 1)

    # ── 2. The accountant records it from To review (Keep studying) ────────
    actx = browser.new_context(viewport={"width": 1440, "height": 900})
    a = sign_in(actx, "Karim Fawzy", "/accounting")
    a.goto(f"{BASE}/accounting?tab=review")
    item = a.locator("[data-refund-request='Sara Nasser']")
    expect(item).to_contain_text("−1,000 EGP")
    shot(a, "01-refund-request", full=True)
    item.get_by_role("button", name="Record refund for Sara Nasser").click()
    d = a.get_by_role("dialog", name="Record refund")
    expect(d.get_by_label("Amount (EGP)")).to_have_value("1000")
    record_btn = d.get_by_role("button", name="Record refund")
    expect(record_btn).to_be_disabled()  # no outcome, no reference yet
    d.get_by_label("Method").select_option("instapay")
    d.get_by_label("Reference").fill("IPN-REFUND-0001")
    d.get_by_label("Keep studying").check()
    expect(d.get_by_text("now 7,000 EGP")).to_be_visible()
    record_btn.click()
    expect(a.get_by_text("Refund recorded. The agreed total was lowered by the refund.")).to_be_visible()
    e = enr(sara)
    check("Recorded from the request: it counts at once and the agreed total drops", refunds(sara) == [{"status": "recorded", "amount": 1000, "outcome": "keep"}] and e["agreed"] == 7000 and e["withdrawn_at"] is None)
    check("The support owner and the credited agent are told", told("Laila Ibrahim", "Refund recorded: Sara Nasser%") == 1 and told("Nour Hassan", "Refund recorded: Sara Nasser%") == 1)

    # ── 3. Where it shows: course card, Accounting ─────────────────────────
    mctx = browser.new_context(viewport={"width": 1440, "height": 900})
    m = sign_in(mctx, "Hana Farouk", "/overview")
    panel = open_customer(m, "Sara Nasser")
    card = panel.get_by_role("region", name=f"Enrollment: {sql('select co.name from public.enrollments e join public.courses co on co.id = e.course_id where e.inquiry_id = $1', [sara])[0]['name']}")
    expect(card.get_by_text("Partly refunded")).to_be_visible()
    expect(card.get_by_test_id("paid")).to_have_text("7,000 EGP")
    expect(card.get_by_test_id("refunded")).to_have_text("1,000 EGP refunded")
    expect(card.get_by_role("list", name="Refunds")).to_contain_text("IPN-REFUND-0001")
    shot(m, "02-course-card", full=True)
    check("The course card shows the refund, Paid net of it and a Partly refunded badge", True)
    m.keyboard.press("Escape")
    m.goto(f"{BASE}/accounting")
    expect(m.get_by_test_id("refunds-out")).to_contain_text("1,000 EGP")
    check("Accounting Overview shows Refunds and Net money in", m.get_by_test_id("net-in").count() == 1)
    m.get_by_role("tab", name="Payments").click()
    expect(m.locator("[data-refund-row='Sara Nasser']")).to_contain_text("−1,000 EGP")
    check("Accounting Payments lists the refund", True)

    # ── 4. A manager records a Withdraw refund ─────────────────────────────
    jana_dues = sql("select count(*)::int as n from public.payment_dues d join public.enrollments e on e.id = d.enrollment_id where e.inquiry_id = $1", [jana])[0]["n"]
    panel = open_customer(m, "Jana Ezzat")
    panel.get_by_role("button", name="Refund", exact=True).click()
    d = m.get_by_role("dialog", name="Record refund")
    d.get_by_label("Amount (EGP)").fill("4500")
    d.get_by_label("Method").select_option("cash")
    d.get_by_label("Reason").select_option("withdrew")
    d.get_by_label("Withdraw").check()
    d.get_by_role("button", name="Record refund").click()
    expect(m.get_by_text(f"Refund recorded. The customer withdrew; {jana_dues} planned payment{'' if jana_dues == 1 else 's'} cancelled.")).to_be_visible()
    remaining = sql("select count(*)::int as n from public.payment_dues d join public.enrollments e on e.id = d.enrollment_id where e.inquiry_id = $1", [jana])[0]["n"]
    check("Withdraw: the course ends and the unpaid plan is cancelled", enr(jana)["withdrawn_at"] is not None and remaining == 0)
    expect(panel.get_by_text("Withdrawn").first).to_be_visible()
    check("A withdrawn course takes no more payments or refunds", panel.get_by_role("button", name="Record payment").count() == 0 and panel.get_by_role("button", name="Refund", exact=True).count() == 0)

    # ── 5. Customers list: Refunded filter and Withdrawn status ────────────
    m.keyboard.press("Escape")
    m.goto(f"{BASE}/customers")
    m.get_by_label("Search customers").fill("")
    m.get_by_role("button", name="Filters", exact=True).click()
    f = m.get_by_role("dialog", name="Filter customers")
    f.get_by_label("Refunded", exact=True).check()
    f.get_by_role("button", name="Show customers").click()
    expect(m.get_by_test_id("enrollment-count")).to_have_text("2 matching")
    names = sorted(set(m.locator("[data-customer]:visible").evaluate_all("els => els.map(e => e.getAttribute('data-customer'))")))
    check("The Refunded filter shows exactly the refunded customers", names == ["Jana Ezzat", "Sara Nasser"], json.dumps(names))

    # ── 6. A request declined from the course card ─────────────────────────
    panel = open_customer(u, "Sara Nasser")
    panel.get_by_role("button", name="Request refund").click()
    d = u.get_by_role("dialog", name="Request refund")
    d.get_by_label("Amount (EGP)").fill("500")
    d.get_by_label("Reason").select_option("overpaid")
    d.get_by_role("button", name="Request refund").click()
    expect(u.get_by_text("Refund requested. A manager or the accountant will decide.")).to_be_visible()
    panel = open_customer(m, "Sara Nasser")
    panel.get_by_role("button", name="Decline").click()
    d = m.get_by_role("dialog", name="Decline refund request")
    d.get_by_label("Reason").fill("The amount paid matches the agreed total")
    d.get_by_role("button", name="Decline").click()
    expect(m.get_by_text("Refund request declined")).to_be_visible()
    check("A declined request tells who asked and changes nothing", refunds(sara)[-1]["status"] == "declined" and told("Laila Ibrahim", "Refund declined: Sara Nasser%") == 1 and enr(sara)["agreed"] == 7000)

    # ── 7. Phone ───────────────────────────────────────────────────────────
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Hana Farouk", "/overview")
    mpanel = open_customer(mp, "Sara Nasser")
    mpanel.get_by_role("button", name="Refund", exact=True).click()
    expect(mp.get_by_role("dialog", name="Record refund")).to_be_visible()
    check("The refund dialog fits a phone", not mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    shot(mp, "03-phone", full=True)
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
