"""
CRM changes, Part A browser test (26 Oct 2026): managers move leads in bulk from the Leads list —
picked leads to one agent, back to the queue, one agent's leads shared across others, and a swap
between two agents. Sales agents cannot. Synthetic data only.

Runs against the production build and a freshly seeded local database:
  python3 tests/e2e/leads_move_e2e.py [screenshot_dir]
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
OPEN = "('new','contacting','qualified','awaiting_payment')"


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


pid = {n: sql("select id from public.profiles where full_name = $1", [n])[0]["id"] for n in ("Nour Hassan", "Youssef Adel", "Mariam Samir", "Hana Farouk")}
open_of = lambda name: sql(f"""select i.id, c.name from public.inquiries i join public.contacts c on c.id = i.contact_id join public.stages s on s.id = i.stage_id
                               where i.sales_owner_id = $1 and s.system_key in {OPEN} order by i.created_at""", [pid[name]])
owner = lambda i: sql("select sales_owner_id from public.inquiries where id = $1", [i])[0]["sales_owner_id"]

# Give every agent two leads of their own with unique names (the seed's leads stay as they are).
for k, name in enumerate(("Nour Hassan", "Youssef Adel", "Mariam Samir")):
    for n in range(2):
        label = f"Move {name.split()[0]} {n}"
        sql("insert into public.contacts (name, phone, phone_normalized, contact_type) values ($1, $2, $2, 'student')", [label, f"+2010990{k}{n:02d}11"])
        sql("""insert into public.inquiries (contact_id, program_id, stage_id, source, sales_owner_id, assigned_at, assignment_method)
               select c.id, (select id from public.programs where code = 'SAT'), (select id from public.stages where system_key = 'new'), 'manual', $2, now(), 'manual'
               from public.contacts c where c.name = $1""", [label, pid[name]])
mine = lambda name: [x for x in open_of(name) if x["name"].startswith("Move ")]

with sync_playwright() as p:
    browser = p.chromium.launch()
    mctx = browser.new_context(viewport={"width": 1440, "height": 900})
    m = sign_in(mctx, "Hana Farouk", "/overview")

    # ── 1. Pick two of Nour's leads and give them to Youssef ────────────────
    two = mine("Nour Hassan")
    m.goto(f"{BASE}/leads")
    search = m.get_by_label("Search by name or phone")
    for lead in two:
        search.fill(lead["name"])
        m.get_by_role("checkbox", name=f"Select {lead['name']}").first.check()
    expect(m.get_by_test_id("picked-count")).to_have_text("2 selected")
    check("Managers pick leads across searches", True)
    sql("delete from public.notifications where user_id = any($1)", [[pid["Nour Hassan"], pid["Youssef Adel"]]])
    m.get_by_role("button", name="Move…").click()
    d = m.get_by_role("dialog", name="Move 2 leads")
    expect(d).to_contain_text("Now with: Nour Hassan 2")
    d.get_by_label("Sales agent").select_option(label="Youssef Adel")
    expect(d.locator("[data-agent-load='Youssef Adel']")).to_contain_text("open now")
    d.get_by_label("Reason").fill("Nour is on leave this week")
    shot(m, "01-move-selected")
    d.get_by_role("button", name="Move", exact=True).click()
    expect(m.get_by_text("2 leads moved")).to_be_visible()
    check("Picked leads move to the chosen agent", all(owner(x["id"]) == pid["Youssef Adel"] for x in two),
          json.dumps([[x["name"], owner(x["id"])] for x in two] + sql("select body from public.activities where type = 'owner_change' order by created_at desc limit 3")))
    yn = sql("select text from public.notifications where user_id = $1", [pid["Youssef Adel"]])
    nn = sql("select text from public.notifications where user_id = $1", [pid["Nour Hassan"]])
    check("One notification each side, with the reason",
          [x["text"] for x in yn] == ["2 leads moved to you by Hana Farouk: Nour is on leave this week"]
          and [x["text"] for x in nn] == ["2 of your leads moved to Youssef Adel by Hana Farouk: Nour is on leave this week"], json.dumps(yn + nn))
    expect(m.get_by_test_id("picked-count")).to_have_count(0)

    # ── 2. Return one lead to the queue ─────────────────────────────────────
    lead = mine("Youssef Adel")[0]
    search.fill(lead["name"])
    m.get_by_role("checkbox", name=f"Select {lead['name']}").first.check()
    m.get_by_role("button", name="Move…").click()
    d = m.get_by_role("dialog", name="Move 1 lead")
    d.get_by_label("Return them to the queue").check()
    d.get_by_label("Reason").fill("Wrong program, needs IELTS")
    d.get_by_role("button", name="Move", exact=True).click()
    expect(m.get_by_text("1 returned to the queue")).to_be_visible()
    acts = sql("select body from public.activities where inquiry_id = $1 and type = 'owner_change' order by created_at desc limit 1", [lead["id"]])
    check("A lead goes back to the queue with a timeline line", acts[0]["body"] == "Returned to the queue by Hana Farouk: Wrong program, needs IELTS", acts[0]["body"])
    search.fill("")

    # ── 3. Share all of Mariam's open leads between Nour and Youssef ────────
    mariam = open_of("Mariam Samir")
    m.get_by_role("button", name="Move leads").click()
    d = m.get_by_role("dialog", name="Move leads")
    d.get_by_label("From agent").select_option(label="Mariam Samir")
    expect(d.get_by_test_id("move-count")).to_contain_text(f"{len(mariam)} lead")
    d.get_by_label("Share across several agents").check()
    d.get_by_label("Nour Hassan").check()
    d.get_by_label("Youssef Adel").check()
    d.get_by_label("Reason").fill("Mariam moves to the support team")
    shot(m, "02-move-agent-share")
    d.get_by_role("button", name="Move", exact=True).click()
    expect(m.get_by_text(f"{len(mariam)} leads moved")).to_be_visible()
    owners = [owner(x["id"]) for x in mariam]
    check("One agent's open leads are shared between two agents in turn",
          len(open_of("Mariam Samir")) == 0 and set(owners) == {pid["Nour Hassan"], pid["Youssef Adel"]} and abs(owners.count(pid["Nour Hassan"]) - owners.count(pid["Youssef Adel"])) <= 1)

    # ── 4. Swap Nour's and Youssef's open SAT leads ─────────────────────────
    nour, youssef = [x["id"] for x in open_of("Nour Hassan")], [x["id"] for x in open_of("Youssef Adel")]
    m.get_by_role("button", name="Move leads").click()
    d = m.get_by_role("dialog", name="Move leads")
    d.get_by_label("From agent").select_option(label="Nour Hassan")
    d.get_by_label("Swap with another agent").check()
    d.get_by_role("combobox", name=re.compile(r"^Swap with")).select_option(label="Youssef Adel")
    expect(d.get_by_test_id("swap-count")).to_have_text(f"{len(nour)} go to Youssef Adel, {len(youssef)} come back to Nour Hassan.")
    d.get_by_label("Reason").fill("Balance the two agents")
    d.get_by_role("button", name="Swap").click()
    expect(m.get_by_text(f"{len(nour) + len(youssef)} leads moved")).to_be_visible()
    check("Swap exchanges two agents' leads in one step",
          all(owner(i) == pid["Youssef Adel"] for i in nour) and all(owner(i) == pid["Nour Hassan"] for i in youssef))
    audit = sql("select action from public.audit_log where action like 'Swapped%' order by created_at desc limit 1")
    check("Each move is one line in the audit history", audit and audit[0]["action"] == f"Swapped {len(nour) + len(youssef)} leads (Balance the two agents)")

    # ── 5. Select the whole page ────────────────────────────────────────────
    m.goto(f"{BASE}/leads")
    m.get_by_role("checkbox", name="Select all leads on this page").check()
    total_rows = m.locator("tbody tr").count()
    expect(m.get_by_test_id("picked-count")).to_have_text(f"{total_rows} selected")
    check("The header box selects every lead on the page", True, f"{total_rows} rows")
    m.get_by_role("button", name="Clear").click()

    # ── 6. Sales agents cannot move leads; phone layout ─────────────────────
    sctx = browser.new_context(viewport={"width": 1440, "height": 900})
    s = sign_in(sctx, "Nour Hassan", "/my-work")
    s.goto(f"{BASE}/leads")
    expect(s.get_by_role("button", name="Move leads")).to_have_count(0)
    check("Sales agents see no move controls and cannot list lead ids",
          s.get_by_role("checkbox", name="Select all leads on this page").count() == 0 and s.request.get(f"{BASE}/api/leads/ids?f={{}}").status == 403)
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Hana Farouk", "/overview")
    mp.goto(f"{BASE}/leads")
    mp.locator("ul input[type=checkbox]").first.check()
    expect(mp.get_by_test_id("picked-count")).to_have_text("1 selected")
    check("Moving fits a phone", not mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    shot(mp, "03-phone")
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
