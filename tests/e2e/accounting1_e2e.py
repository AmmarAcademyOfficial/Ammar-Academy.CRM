"""
Accounting plan, phase 1 browser test (22 Oct 2026): support records a payment with its type and
receipt, the payment plan shows paid / upcoming / overdue, balance left, the Payments due lists for
support and managers, payment alerts, and the new notification settings.

Runs against the production build and a freshly seeded local database:
  python3 tests/e2e/accounting1_e2e.py [screenshot_dir]
Synthetic data only.
"""
import json
import re
import struct
import subprocess
import sys
import zlib
from datetime import datetime, timedelta, timezone
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


def png_bytes():
    raw = b"".join(b"\x00" + b"\x20\x90\xf0" * 8 for _ in range(8))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def sign_in(ctx, name, path):
    page = ctx.new_page()
    page.goto(f"{BASE}/login")
    page.get_by_role("button", name=name).click()
    page.wait_for_url(f"**{path}*")
    return page


def uid(name):
    return sql("select id from public.profiles where full_name = $1", [name])[0]["id"]


cairo_today = (datetime.now(timezone.utc) + timedelta(hours=3)).date()
iso = lambda d: d.isoformat()
laila, hana = uid("Laila Ibrahim"), uid("Hana Farouk")
jana = sql("""select i.id as inquiry, e.id as enrollment, o.id as onboarding from public.inquiries i join public.contacts c on c.id = i.contact_id
              join public.enrollments e on e.inquiry_id = i.id join public.onboardings o on o.enrollment_id = e.id where c.name = 'Jana Ezzat'""")[0]
# Laila takes Jana (seeded in the queue with a 10,500 EGP balance and a two-step payment plan).
sql("update public.onboardings set support_owner_id = $1, claimed_at = now(), status = 'onboarding' where id = $2", [laila, jana["onboarding"]])
receipt = Path("/tmp") / "accounting1-receipt.png"
receipt.write_bytes(png_bytes())

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── 1. Support sees the balance and the plan ────────────────────────────
    uctx = browser.new_context(viewport={"width": 1440, "height": 900})
    u = sign_in(uctx, "Laila Ibrahim", "/my-work")
    line = u.locator("li").filter(has_text="Jana Ezzat").filter(has_text=" paid").first
    expect(line).to_contain_text("10,500 EGP left")
    expect(line.locator("[data-next-payment=overdue]")).to_contain_text("Payment overdue: 5,000 EGP")
    check("Support lists show the balance left and an overdue planned payment", True)
    card = u.get_by_role("list", name="Payments due")
    expect(card.locator("li").filter(has_text="Jana Ezzat")).to_have_count(1)
    check("Payments due lists the overdue payment for its support owner", card.locator("[data-due=overdue]").count() >= 1)
    shot(u, "01-support-my-work")

    line.get_by_role("button").first.click()
    panel = u.get_by_role("dialog", name="Customer details")
    panel.get_by_role("tab", name="Payments").click()
    expect(panel.get_by_test_id("balance-left")).to_have_text("10,500 EGP")
    plan = panel.get_by_role("region", name="Payment plan")
    expect(plan.locator("[data-due=overdue]")).to_have_count(1)
    expect(plan.locator("[data-due=upcoming]")).to_have_count(1)
    check("The customer panel shows the payment plan with its statuses", True)

    # ── 2. Support records an installment with a receipt ────────────────────
    panel.get_by_role("button", name="Record payment").click()
    d = u.get_by_role("dialog", name="Record payment")
    expect(d.get_by_label("Payment type")).to_have_value("installment")
    check("The type starts as Installment after a first payment", True)
    d.get_by_label("Payment type").select_option("full")
    expect(d.get_by_label("Amount (EGP)")).to_have_value("10500")
    check("Full payment fills in the whole remaining balance", True)
    d.get_by_label("Payment type").select_option("installment")
    d.get_by_label("Amount (EGP)").fill("5000")
    expect(d.get_by_text("Next payment (optional)")).to_be_visible()
    check("After a partial payment, support is offered the next payment date", True)
    d.get_by_label("Method").select_option("instapay")
    d.get_by_label("Reference").fill("IPN-ACC1-4401")
    d.locator("#receipt-file").set_input_files(str(receipt))
    expect(d.get_by_text("accounting1-receipt.png")).to_be_visible()
    shot(u, "02-record-payment")
    d.get_by_role("button", name="Submit for confirmation").click()
    expect(u.get_by_text("Payment submitted. A manager will confirm it.")).to_be_visible()
    pay = sql("""select p.id, p.status, p.kind, p.submitted_by, p.receipt_mime from public.payments p where p.enrollment_id = $1 and p.reference = 'IPN-ACC1-4401'""", [jana["enrollment"]])[0]
    check("Support's payment is saved as a pending installment with the receipt",
          pay["status"] == "pending" and pay["kind"] == "installment" and pay["submitted_by"] == laila and pay["receipt_mime"] == "image/png")
    expect(panel.locator("[data-kind=installment]").first).to_have_text("Installment")
    u.keyboard.press("Escape")

    # ── 3. The manager confirms; the plan updates ───────────────────────────
    mctx = browser.new_context(viewport={"width": 1440, "height": 900})
    m = sign_in(mctx, "Hana Farouk", "/overview")
    m.goto(f"{BASE}/payments")
    item = m.locator("article").filter(has_text="5,000 EGP").filter(has_text="Installment").first
    expect(item).to_be_visible()
    check("The manager sees the payment type in the review queue", True)
    item.get_by_role("button", name="Confirm").click()
    expect(m.get_by_text("Payment confirmed")).to_be_visible()
    states = [r["status"] for r in sql("select status from private.dues_state($1) order by due_on", [jana["enrollment"]])]
    check("A confirmed payment marks the earliest planned payment as paid", states == ["paid", "upcoming"], str(states))

    # ── 4. Support changes the plan ─────────────────────────────────────────
    u.reload()
    u.locator("li").filter(has_text="Jana Ezzat").filter(has_text=" paid").first.get_by_role("button").first.click()
    panel.get_by_role("tab", name="Payments").click()
    expect(panel.get_by_test_id("balance-left")).to_have_text("5,500 EGP")
    plan = panel.get_by_role("region", name="Payment plan")
    plan.get_by_role("button", name=re.compile("^Change payment due")).click()
    dd = u.get_by_role("dialog", name="Change expected payment")
    soon = cairo_today + timedelta(days=3)
    dd.get_by_label("Due date").fill(iso(soon))
    dd.get_by_label("Amount (EGP)").fill("3000")
    dd.get_by_role("button", name="Save").click()
    expect(u.get_by_text("Payment plan updated")).to_be_visible()
    plan.get_by_role("button", name="Add expected payment").click()
    da = u.get_by_role("dialog", name="Add expected payment")
    da.get_by_label("Due date").fill(iso(cairo_today + timedelta(days=33)))
    da.get_by_label("Amount (EGP)").fill("4000")
    da.get_by_role("button", name="Save").click()
    expect(u.get_by_text("The planned payments add up to more than the balance left (5,500 EGP).")).to_be_visible()
    check("The plan cannot add up to more than the balance left", True)
    da.get_by_label("Amount (EGP)").fill("2500")
    da.get_by_role("button", name="Save").click()
    expect(u.get_by_text("Added to the payment plan")).to_be_visible()
    rows = sql("select amount::float8 as amount, to_char(due_on, 'YYYY-MM-DD') as due_on, status from private.dues_state($1) order by due_on", [jana["enrollment"]])
    check("Support can change and add planned payments",
          [(r["amount"], r["status"]) for r in rows] == [(5000, "paid"), (3000, "upcoming"), (2500, "upcoming")] and rows[1]["due_on"] == iso(soon), str(rows))
    timeline = sql("select count(*)::int as n from public.activities where inquiry_id = $1 and type = 'payment_plan'", [jana["inquiry"]])[0]["n"]
    check("Plan changes are on the customer's timeline", timeline >= 2)
    shot(u, "03-payment-plan")
    u.keyboard.press("Escape")

    # ── 5. Managers: Payments due across support ────────────────────────────
    m.goto(f"{BASE}/customers")
    mcard = m.get_by_role("list", name="Payments due")
    mrow = mcard.locator("li").filter(has_text="Jana Ezzat")
    expect(mrow).to_contain_text("3,000 EGP")
    expect(mrow).to_contain_text("Laila Ibrahim")
    check("Managers see payments due for every support agent's customers", True)
    shot(m, "04-manager-payments-due")

    # ── 6. The sales agent sees the plan but cannot change it ──────────────
    sctx = browser.new_context(viewport={"width": 1440, "height": 900})
    s = sign_in(sctx, "Youssef Adel", "/my-work")
    s.goto(f"{BASE}/leads")
    s.get_by_placeholder(re.compile("Search name or phone")).fill("Jana Ezzat")
    s.wait_for_timeout(900)
    s.locator("tbody tr").filter(has_text="Jana Ezzat").first.click()
    sp = s.get_by_role("dialog", name="Customer details")
    sp.get_by_role("tab", name="Payments").click()
    splan = sp.get_by_role("region", name="Payment plan")
    expect(splan.locator("li")).to_have_count(3)
    check("The sales agent sees the plan, read only", splan.get_by_role("button", name="Add expected payment").count() == 0
          and splan.get_by_role("button", name=re.compile("^Change payment due")).count() == 0)

    # ── 7. Alerts ───────────────────────────────────────────────────────────
    sql("update public.payment_dues set due_on = $2::date - 1 where enrollment_id = $1 and amount = 3000", [jana["enrollment"], iso(cairo_today)])
    ten_am = f"{iso(cairo_today)}T07:00:00Z"  # 10:00 Cairo
    r = sql("select private.send_timed_alerts($1) as r", [ten_am])[0]["r"]
    check("The scheduler sends overdue payment alerts", r["payments_overdue"] >= 1, json.dumps(r))
    told = sql("select user_id, text from public.notifications where inquiry_id = $1 and kind = 'payment_overdue'", [jana["inquiry"]])
    who = {t["user_id"] for t in told}
    check("Overdue goes to the support owner and the managers", laila in who and hana in who and
          any(re.match(r"^Payment overdue: Jana Ezzat · 3,000 EGP was due \d{1,2} \w{3} \(1 days ago\)\.$", t["text"]) for t in told), str(told))

    m.goto(f"{BASE}/settings/notifications")
    expect(m.get_by_role("switch", name="Payment overdue: notify customer support")).to_have_attribute("aria-checked", "true")
    expect(m.get_by_label("Remind before a planned payment")).to_have_value("1")
    check("The payment alerts are in Settings → Notifications", True)

    # ── 8. Phone layout ─────────────────────────────────────────────────────
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Laila Ibrahim", "/my-work")
    mp.wait_for_load_state("networkidle")
    check("Support My Work with Payments due fits a phone", not mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    mp.locator("li").filter(has_text="Jana Ezzat").filter(has_text=" paid").first.get_by_role("button").first.click()
    mpanel = mp.get_by_role("dialog", name="Customer details")
    mpanel.get_by_role("tab", name="Payments").click()
    mpanel.get_by_role("button", name="Record payment").click()
    mp.wait_for_timeout(400)
    check("The payment dialog fits a phone", not mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    shot(mp, "05-phone-record-payment")
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
