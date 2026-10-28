"""
CRM changes plan 3, release 2 browser test (28 Oct 2026): a manager deletes a payment, an enrollment
and a lead after seeing what goes with each (the word DELETE for confirmed money), and restores them
from Settings → Deleted items with the same ids; the accountant deletes and restores a payment from
Accounting → Deleted items but cannot delete enrollments or leads; support sees no Delete at all.
Synthetic data only.

Runs against the production build and a freshly seeded local database:
  python3 tests/e2e/delete_restore_e2e.py [screenshot_dir]
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
tarek = lead_id("Tarek Nabil")
sara_enr = sql("select e.id, co.name from public.enrollments e join public.courses co on co.id = e.course_id where e.inquiry_id = $1", [sara])[0]
SARA_COURSE = sara_enr["name"]
sara_sessions = sql("select count(*)::int as n from public.teacher_sessions where enrollment_id = $1", [sara_enr["id"]])[0]["n"]
tarek_pay = sql("select p.id from public.payments p join public.enrollments e on e.id = p.enrollment_id where e.inquiry_id = $1", [tarek])[0]["id"]
gone = lambda table, id_: sql(f"select count(*)::int as n from public.{table} where id = $1", [id_])[0]["n"] == 0

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── 1. Manager deletes a rejected payment (no money, so no DELETE to type) ──
    mctx = browser.new_context(viewport={"width": 1440, "height": 900})
    m = sign_in(mctx, "Hana Farouk", "/overview")
    panel = open_lead(m, "Tarek Nabil")
    panel.get_by_role("tab", name="Payments").click()
    panel.get_by_role("button", name="Delete payment 2,000 EGP").click()
    d = m.get_by_role("dialog", name="Delete payment")
    expect(d.get_by_test_id("delete-summary")).to_contain_text("This deletes: 1 payment.")
    check("The dialog says exactly what goes; no DELETE to type without confirmed money", d.get_by_label("Type DELETE to confirm").count() == 0)
    delete_btn = d.get_by_role("button", name="Delete", exact=True)
    expect(delete_btn).to_be_disabled()
    d.get_by_label("Reason").fill("Entered by mistake")
    delete_btn.click()
    expect(m.get_by_text("Deleted. You can restore it from Settings → Deleted items within 30 days.")).to_be_visible()
    check("A manager deletes a payment with a reason", gone("payments", tarek_pay))

    # ── 2. Manager deletes an enrollment with confirmed money: DELETE must be typed ──
    m.keyboard.press("Escape")
    panel = open_customer(m, "Sara Nasser")
    panel.get_by_role("button", name=f"Delete enrollment {SARA_COURSE}").click()
    d = m.get_by_role("dialog", name="Delete enrollment")
    summary = d.get_by_test_id("delete-summary")
    expect(summary).to_contain_text(f"1 enrollment, 1 payment (8,000 EGP confirmed), {sara_sessions} sessions")
    d.get_by_label("Reason").fill("Booked on the wrong course")
    delete_btn = d.get_by_role("button", name="Delete", exact=True)
    expect(delete_btn).to_be_disabled()
    d.get_by_label("Type DELETE to confirm").fill("delete")
    expect(delete_btn).to_be_disabled()
    d.get_by_label("Type DELETE to confirm").fill("DELETE")
    shot(m, "01-delete-enrollment")
    delete_btn.click()
    expect(m.get_by_text("Deleted. You can restore it from Settings → Deleted items within 30 days.")).to_be_visible()
    check("Confirmed money needs the word DELETE; the enrollment, its payment and sessions go",
          gone("enrollments", sara_enr["id"]) and sql("select count(*)::int as n from public.teacher_sessions where enrollment_id = $1", [sara_enr["id"]])[0]["n"] == 0)
    check("The customer's lead stays", not gone("inquiries", sara))

    # ── 3. Settings → Deleted items: restore with the same ids ─────────────
    m.goto(f"{BASE}/settings/deleted")
    item = m.locator("[data-deleted-item]").filter(has_text=SARA_COURSE)
    expect(item).to_contain_text("Booked on the wrong course")
    expect(m.locator("[data-deleted-item]").filter(has_text="Tarek Nabil")).to_contain_text("Entered by mistake")
    shot(m, "02-deleted-items", full=True)
    item.get_by_role("button", name="Restore").click()
    expect(m.get_by_text("Enrollment restored.")).to_be_visible()
    back = sql("select (select count(*)::int from public.payments where enrollment_id = $1) as pays, (select count(*)::int from public.teacher_sessions where enrollment_id = $1) as sess", [sara_enr["id"]])[0]
    check("Restore puts the enrollment back with its payment and sessions, same ids", not gone("enrollments", sara_enr["id"]) and back == {"pays": 1, "sess": sara_sessions}, json.dumps(back))
    expect(m.locator("[data-deleted-item]").filter(has_text=SARA_COURSE)).to_have_count(0)

    # ── 4. Manager deletes a lead from the ⋯ menu, then restores it ─────────
    panel = open_lead(m, "Tarek Nabil")
    panel.get_by_role("button", name="More actions").click()
    panel.get_by_role("button", name="Delete this lead").click()
    d = m.get_by_role("dialog", name="Delete lead")
    expect(d.get_by_test_id("delete-summary")).to_contain_text("1 person, 1 lead, 1 enrollment")
    d.get_by_label("Reason").fill("Test record")
    d.get_by_role("button", name="Delete", exact=True).click()
    expect(m.get_by_text("Deleted. You can restore it from Settings → Deleted items within 30 days.")).to_be_visible()
    expect(m.get_by_role("dialog", name="Customer details")).to_have_count(0)
    check("Deleting a lead closes the record and removes it", gone("inquiries", tarek))
    m.goto(f"{BASE}/settings/deleted")
    m.locator("[data-deleted-item]").filter(has_text="Tarek Nabil").filter(has_text="Test record").get_by_role("button", name="Restore").click()
    expect(m.get_by_text("Lead restored.")).to_be_visible()
    check("The lead comes back with the same id", not gone("inquiries", tarek))
    audit = sql("select action from public.audit_log where action in ('Deleted lead (Test record)', 'Restored lead') order by created_at")
    check("Each delete and restore is in the audit history", [a["action"] for a in audit] == ["Deleted lead (Test record)", "Restored lead"], json.dumps(audit))

    # ── 5. The accountant: payments only, and their own Deleted items ───────
    actx = browser.new_context(viewport={"width": 1440, "height": 900})
    a = sign_in(actx, "Karim Fawzy", "/accounting")
    apanel = open_customer(a, "Jana Ezzat")
    jana_pay = sql("select p.id from public.payments p join public.enrollments e on e.id = p.enrollment_id where e.inquiry_id = $1 and p.status = 'confirmed'", [lead_id("Jana Ezzat")])[0]["id"]
    check("The accountant cannot delete enrollments or leads", apanel.get_by_role("button", name="Delete enrollment").count() == 0
          and apanel.get_by_role("button", name="More actions").count() == 0)
    apanel.get_by_role("button", name="Delete payment 4,500 EGP").click()
    d = a.get_by_role("dialog", name="Delete payment")
    d.get_by_label("Reason").fill("Recorded on the wrong customer")
    d.get_by_label("Type DELETE to confirm").fill("DELETE")
    d.get_by_role("button", name="Delete", exact=True).click()
    # Jana was handed over on her deposit: without it she is below the rule, so she is flagged (support keeps her).
    expect(a.get_by_text("Deleted. The customer is now below the handover rule and was flagged for review. Restore it from Accounting → Deleted items within 30 days.")).to_be_visible()
    flag = sql("select o.flagged_reason from public.onboardings o join public.enrollments e on e.id = o.enrollment_id where e.inquiry_id = $1", [lead_id("Jana Ezzat")])[0]["flagged_reason"]
    check("The accountant deletes a confirmed payment; the customer is flagged below the handover rule",
          gone("payments", jana_pay) and (flag or "").startswith("A payment of 4,500 EGP was deleted (Recorded on the wrong customer)"), flag)
    a.goto(f"{BASE}/accounting?tab=deleted")
    rows = a.locator("[data-deleted-item]")
    expect(rows.filter(has_text="Jana Ezzat")).to_be_visible()
    check("The accountant sees only the payments they deleted", rows.count() == 1)
    rows.first.get_by_role("button", name="Restore").click()
    expect(a.get_by_text("Payment restored.")).to_be_visible()
    check("…and restores it", not gone("payments", jana_pay))

    # ── 6. Support sees no Delete ──────────────────────────────────────────
    uctx = browser.new_context(viewport={"width": 1440, "height": 900})
    u = sign_in(uctx, "Laila Ibrahim", "/my-work")
    upanel = open_customer(u, "Sara Nasser")
    expect(upanel.get_by_text("8,000 EGP").first).to_be_visible()
    check("Support has no Delete on payments or enrollments", upanel.get_by_role("button", name="Delete", exact=False).count() == 0)

    # ── 7. Phone ───────────────────────────────────────────────────────────
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Hana Farouk", "/overview")
    mpanel = open_customer(mp, "Sara Nasser")
    mpanel.get_by_role("button", name=f"Delete enrollment {SARA_COURSE}").click()
    expect(mp.get_by_role("dialog", name="Delete enrollment").get_by_test_id("delete-summary")).to_be_visible()
    check("The delete dialog fits a phone", not mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    shot(mp, "03-phone", full=True)
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
