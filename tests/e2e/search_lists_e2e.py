"""
CRM changes plan 3, release 1 browser test (28 Oct 2026): search in long lists — any dropdown with
more than 7 choices gets a search button, Arabic letter variants match, picking a result sets the
dropdown, long filter tick lists get a search box, and short lists stay plain. Synthetic data only.

Runs against the production build and a freshly seeded local database:
  python3 tests/e2e/search_lists_e2e.py [screenshot_dir]
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


# Ten more teachers (with rates), so the teacher list is long; one Arabic name with letter variants.
NAMES = ["مُصطفى سامي", "Karim Adel", "Laila Hosny", "Omar Farid", "Rania Zaki", "Tamer Nabil", "Yara Samir", "Ziad Ehab", "Mona Fathy", "Hany Lotfy"]
ielts = sql("select id from public.programs where code = 'IELTS'")[0]["id"]
for n in NAMES:
    t = sql("insert into public.teachers (full_name, program_ids) values ($1, array[$2]::uuid[]) returning id", [n, ielts])[0]["id"]
    r = sql("insert into public.teacher_rates (teacher_id, name) values ($1, 'Private hour') returning id", [t])[0]["id"]
    sql("insert into public.teacher_rate_amounts (rate_id, amount, valid_from) values ($1, 300, '2026-01-01')", [r])
mostafa = sql("select id from public.teachers where full_name = $1", [NAMES[0]])[0]["id"]

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── 1. A long dropdown: search, Arabic variants, pick ───────────────────
    uctx = browser.new_context(viewport={"width": 1440, "height": 900})
    u = sign_in(uctx, "Laila Ibrahim", "/my-work")
    u.goto(f"{BASE}/customers")
    u.get_by_label("Search customers").fill("Sara")
    u.locator("[data-customer='Sara Nasser']:visible").first.click()
    panel = u.get_by_role("dialog", name="Customer details")
    panel.get_by_role("tab", name="Support").click()
    panel.get_by_role("button", name="Assign teacher").click()
    d = u.get_by_role("dialog", name="Assign teacher")
    teacher = d.get_by_label("Teacher")
    expect(teacher).to_be_visible()
    search_buttons = d.get_by_role("button", name="Search this list")
    check("A list of more than 7 teachers has a search button", search_buttons.count() >= 1)
    search_buttons.first.click()
    box = d.get_by_role("combobox", name="Search Teacher")
    expect(box).to_be_focused()
    box.fill("مصطفي")  # typed without the diacritics and with ي instead of ى
    options = d.get_by_role("listbox").get_by_role("option")
    expect(options).to_have_count(1)
    expect(options.first).to_have_text(NAMES[0])
    shot(u, "01-teacher-search")
    check("Typing finds the teacher, Arabic letter variants included", True)
    box.press("Enter")
    expect(teacher).to_have_value(mostafa)
    expect(d.get_by_role("listbox")).to_have_count(0)
    check("Picking a result sets the dropdown, as choosing it in the list would", True)
    rates = d.get_by_label("Rate").locator("option").all_inner_texts()
    check("The screen reacts to the choice (the teacher's rates load)", rates and all("Private hour" in r for r in rates), json.dumps(rates))
    d.get_by_role("button", name="Search this list").first.click()
    d.get_by_role("combobox", name="Search Teacher").fill("zzz")
    expect(d.get_by_text("No match. Try fewer letters.")).to_be_visible()
    d.get_by_role("combobox", name="Search Teacher").press("Escape")
    check("No match says so; Escape closes the search", d.get_by_role("listbox").count() == 0)
    d.get_by_role("button", name="Cancel").click()
    assigned = sql("select count(*)::int as n from public.teacher_assignments where teacher_id = $1", [mostafa])[0]["n"]
    check("Nothing is saved until Assign is clicked", assigned == 0)

    # ── 2. Short lists stay plain ──────────────────────────────────────────
    panel.get_by_role("tab", name="Payments").click()
    status_select = panel.get_by_label("Stage")  # 7 stages, owner-only control; support sees a badge instead
    check("Lists of 7 or fewer have no search button", panel.get_by_role("button", name="Search this list").count() == 0)

    # ── 3. A long tick list in the filters ─────────────────────────────────
    mctx = browser.new_context(viewport={"width": 1440, "height": 900})
    m = sign_in(mctx, "Hana Farouk", "/overview")
    m.goto(f"{BASE}/leads")
    m.get_by_role("button", name="Filters").click()
    f = m.get_by_role("dialog", name="Filters")
    course_search = f.get_by_label("Search Course")
    expect(course_search).to_be_visible()
    f.get_by_label("SAT · Mock exam pack (4 tests)").check()
    course_search.fill("ielts")
    visible = [c for c in f.get_by_role("group", name="Course", exact=True).get_by_role("checkbox").all() if c.is_visible()]
    labels = [f.locator(f"label[for='{c.get_attribute('id')}']").inner_text() for c in visible]
    shot(m, "02-filter-search")
    check("The course filter narrows as you type; ticked courses stay visible",
          "SAT · Mock exam pack (4 tests)" in labels and all("IELTS" in x or "Mock" in x for x in labels) and len(labels) >= 2, json.dumps(labels))
    check("Short tick lists (stages) have no search box", f.get_by_label("Search Stage").count() == 0)

    # ── 4. Phone ───────────────────────────────────────────────────────────
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Laila Ibrahim", "/my-work")
    mp.goto(f"{BASE}/customers")
    mp.get_by_label("Search customers").fill("Sara")
    mp.locator("[data-customer='Sara Nasser']:visible").first.click()
    mpanel = mp.get_by_role("dialog", name="Customer details")
    mpanel.get_by_role("tab", name="Support").click()
    mpanel.get_by_role("button", name="Assign teacher").click()
    md = mp.get_by_role("dialog", name="Assign teacher")
    md.get_by_role("button", name="Search this list").first.click()
    md.get_by_role("combobox", name="Search Teacher").fill("ya")
    expect(md.get_by_role("listbox").get_by_role("option", name="Yara Samir")).to_be_visible()
    check("The search fits a phone", not mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    shot(mp, "03-phone", full=True)
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
