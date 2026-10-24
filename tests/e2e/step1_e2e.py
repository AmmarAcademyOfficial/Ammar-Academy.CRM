"""
Step 1 browser test (22 Oct 2026): yellow "New" highlight until the owner opens a lead,
"Not Opened Yet" filter and My Work count, returning customers going to their previous agent
with a notification and an "earlier leads" box, and the same highlight for support.

Runs against the production build and a freshly seeded local database:
  python3 tests/e2e/step1_e2e.py [screenshot_dir]
Synthetic data only.
"""
import json
import re
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
        page.wait_for_load_state("networkidle")
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


def uid(name):
    return sql("select id from public.profiles where full_name = $1", [name])[0]["id"]


def opened_at(inquiry):
    return sql("select owner_opened_at from public.inquiries where id = $1", [inquiry])[0]["owner_opened_at"]


nour = uid("Nour Hassan")
youssef = uid("Youssef Adel")
laila = uid("Laila Ibrahim")

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── 1. Highlight: a lead of Nour's she has not opened ───────────────────
    target = sql("""select i.id, c.name from public.inquiries i join public.contacts c on c.id = i.contact_id
                    join public.stages s on s.id = i.stage_id
                    where i.sales_owner_id = $1 and i.owner_opened_at is null and not s.is_closed
                    order by i.created_at desc limit 1""", [nour])
    if not target:  # make one: an open, uncontacted lead given to Nour by a manager
        sql("update public.inquiries set owner_opened_at = null where id = (select i.id from public.inquiries i join public.stages s on s.id = i.stage_id where i.sales_owner_id = $1 and not s.is_closed limit 1)", [nour])
        target = sql("select i.id, c.name from public.inquiries i join public.contacts c on c.id = i.contact_id where i.sales_owner_id = $1 and i.owner_opened_at is null limit 1", [nour])
    lead_id, lead_name = target[0]["id"], target[0]["name"]
    unopened_nour = sql("select count(*)::int as n from public.inquiries i join public.stages s on s.id = i.stage_id join public.contacts c on c.id = i.contact_id where i.sales_owner_id = $1 and i.owner_opened_at is null and not s.is_closed and not c.do_not_contact", [nour])[0]["n"]

    mctx = browser.new_context(viewport={"width": 1440, "height": 900})
    m = sign_in(mctx, "Hana Farouk", "/overview")
    m.goto(f"{BASE}/leads")
    m.get_by_placeholder(re.compile("Search name or phone")).fill(lead_name)
    m.wait_for_timeout(900)
    row = m.locator("tr[data-unopened]").filter(has_text=lead_name).first
    expect(row).to_be_visible()
    check("An unopened lead is highlighted in yellow with a New label", row.locator("[data-badge=new]").count() == 1
          and "rgb(255, 248, 204)" in row.evaluate("e => getComputedStyle(e).backgroundColor"))
    shot(m, "01-leads-highlight")

    row.click()
    m.get_by_role("dialog", name="Customer details").wait_for()
    m.wait_for_timeout(800)
    check("A manager opening the lead does not clear it", opened_at(lead_id) is None)
    m.keyboard.press("Escape")

    # "Not Opened Yet" built-in view lists only unopened leads.
    m.get_by_placeholder(re.compile("Search name or phone")).fill("")
    m.get_by_role("tab", name="Not Opened Yet").click()
    m.wait_for_timeout(800)
    rows = m.locator("tbody tr")
    total_unopened = sql("select count(*)::int as n from public.inquiries where sales_owner_id is not null and owner_opened_at is null")[0]["n"]
    shown = min(total_unopened, rows.count())
    check("The Not Opened Yet view shows only highlighted leads", rows.count() > 0 and m.locator("tbody tr[data-unopened]").count() == rows.count(),
          f"{rows.count()} rows, {total_unopened} unopened in total")

    # ── 2. The owner opens it: highlight clears ─────────────────────────────
    sctx = browser.new_context(viewport={"width": 1440, "height": 900})
    s = sign_in(sctx, "Nour Hassan", "/my-work")
    new_stat = s.get_by_role("button", name=re.compile("New, not opened yet"))
    expect(new_stat).to_contain_text(str(unopened_nour))
    check("My Work counts the agent's unopened leads", True, f"{unopened_nour}")
    new_stat.click()
    item = s.locator("li[data-unopened]").filter(has_text=lead_name).first
    expect(item).to_be_visible()
    shot(s, "02-my-work-new")
    item.get_by_role("button").first.click()
    s.get_by_role("dialog", name="Customer details").wait_for()
    for _ in range(20):
        if opened_at(lead_id):
            break
        s.wait_for_timeout(250)
    check("The owner opening the lead clears it", opened_at(lead_id) is not None)
    s.keyboard.press("Escape")
    s.goto(f"{BASE}/leads")
    s.get_by_placeholder(re.compile("Search name or phone")).fill(lead_name)
    s.wait_for_timeout(900)
    plain = s.locator("tbody tr").filter(has_text=lead_name).first
    check("After opening, the row is back to normal", plain.get_attribute("data-unopened") is None and plain.locator("[data-badge=new]").count() == 0)

    # ── 3. Returning customer goes to the previous agent ────────────────────
    prev = sql("""select c.phone_normalized as phone, c.name, pr.code from public.inquiries i
                  join public.contacts c on c.id = i.contact_id join public.programs pr on pr.id = i.program_id
                  where i.sales_owner_id = $1
                    and not exists (select 1 from public.inquiries j where j.contact_id = c.id and j.program_id <> i.program_id)
                  order by i.created_at limit 1""", [youssef])[0]
    other_program = "IELTS" if prev["code"] == "SAT" else "SAT"
    program_name = sql("select name from public.programs where code = $1", [other_program])[0]["name"]
    before_notes = sql("select count(*)::int as n from public.notifications where user_id = $1", [youssef])[0]["n"]
    m.goto(f"{BASE}/leads")
    m.get_by_role("button", name="Add customer").first.click()
    dlg = m.get_by_role("dialog", name="Add customer")
    dlg.get_by_label(re.compile(r"^Name")).fill(prev["name"])
    dlg.get_by_label(re.compile(r"^Phone number")).fill(prev["phone"])
    dlg.get_by_label(re.compile(r"^Program")).select_option(label=program_name)
    dlg.get_by_role("button", name="Add customer").click()
    expect(dlg).to_have_count(0)
    new_inq = sql("""select i.id, i.sales_owner_id, i.assignment_method from public.inquiries i join public.contacts c on c.id = i.contact_id
                     join public.programs pr on pr.id = i.program_id where c.phone_normalized = $1 and pr.code = $2""", [prev["phone"], other_program])[0]
    check("A returning customer's new lead goes to their previous agent", new_inq["sales_owner_id"] == youssef and new_inq["assignment_method"] == "returning",
          f"{prev['name']}: {prev['code']} before, now {other_program}")
    note = sql("select text from public.notifications where user_id = $1 order by created_at desc limit 1", [youssef])[0]["text"]
    check("The previous agent is told this is a returning customer",
          sql("select count(*)::int as n from public.notifications where user_id = $1", [youssef])[0]["n"] == before_notes + 1
          and note.startswith("Returning customer assigned to you:") and f"({prev['code']}," in note, note)

    yctx = browser.new_context(viewport={"width": 1440, "height": 900})
    y = sign_in(yctx, "Youssef Adel", "/my-work")
    y.goto(f"{BASE}/leads")
    y.get_by_placeholder(re.compile("Search name or phone")).fill(prev["name"])
    y.wait_for_timeout(900)
    yrow = y.locator("tr[data-unopened]").filter(has_text=prev["name"]).filter(has_text=other_program).first
    check("It shows as New and Returning customer in the agent's list",
          yrow.locator("[data-badge=new]").count() == 1 and yrow.get_by_text("Returning customer").count() == 1)
    yrow.click()
    panel = y.get_by_role("dialog", name="Customer details")
    box = panel.get_by_role("region", name="Earlier leads")
    expect(box).to_contain_text("1 earlier lead")
    expect(box).to_contain_text(f"{prev['code']} ·")
    check("The lead panel lists the customer's earlier lead", True)
    shot(y, "03-returning-panel")
    y.keyboard.press("Escape")

    # ── 4. Support: a customer given to Laila is highlighted until she opens it ──
    ob = sql("""select o.id, e.inquiry_id, c.name from public.onboardings o join public.enrollments e on e.id = o.enrollment_id
                join public.inquiries i on i.id = e.inquiry_id join public.contacts c on c.id = i.contact_id
                where o.support_owner_id is null limit 1""")
    if ob:
        ob = ob[0]
        sql("update public.onboardings set support_owner_id = $1, claimed_at = now(), status = 'onboarding' where id = $2", [laila, ob["id"]])
        uctx = browser.new_context(viewport={"width": 1440, "height": 900})
        u = sign_in(uctx, "Laila Ibrahim", "/my-work")
        line = u.locator("li[data-unopened]").filter(has_text=ob["name"]).first
        expect(line).to_be_visible()
        check("Support: a customer assigned to you is highlighted as New", line.locator("[data-badge=new]").count() == 1)
        shot(u, "04-support-new")
        line.get_by_role("button").first.click()
        u.get_by_role("dialog", name="Customer details").wait_for()
        cleared = None
        for _ in range(20):
            cleared = sql("select support_opened_at from public.onboardings where id = $1", [ob["id"]])[0]["support_opened_at"]
            if cleared:
                break
            u.wait_for_timeout(250)
        check("Support: opening the customer clears it", cleared is not None)

    # ── 5. Phone layout ─────────────────────────────────────────────────────
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Youssef Adel", "/my-work")
    mp.goto(f"{BASE}/leads")
    mp.wait_for_load_state("networkidle")
    check("Leads with labels fit a phone screen", not mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    shot(mp, "05-phone")
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
