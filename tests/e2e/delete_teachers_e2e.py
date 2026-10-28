"""
CRM changes plan 3, release 3 browser test (28 Oct 2026): a manager deletes a teacher nobody used
and restores it from Deleted items; a teacher or rate already used cannot be deleted, and the dialog
says what links it and offers Not active or Archive instead. Synthetic data only.

Runs against the production build and a freshly seeded local database:
  python3 tests/e2e/delete_teachers_e2e.py [screenshot_dir]
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



NEW = "Tamer Unused"
t = sql("insert into public.teachers (full_name, program_ids) values ($1, array(select id from public.programs where code = 'IELTS')) returning id", [NEW])[0]["id"]
r = sql("insert into public.teacher_rates (teacher_id, name) values ($1, 'Trial hour') returning id", [t])[0]["id"]
sql("insert into public.teacher_rate_amounts (rate_id, amount, valid_from) values ($1, 300, '2026-01-01')", [r])
exists = lambda table, id_: sql(f"select count(*)::int as n from public.{table} where id = $1", [id_])[0]["n"] == 1
dina = sql("select id from public.teachers where full_name = 'Dina Kamal'")[0]["id"]
sami_group = sql("select r.id from public.teacher_rates r join public.teachers t on t.id = r.teacher_id where t.full_name = 'Ahmed Sami' and r.name = 'SAT group'")[0]["id"]

with sync_playwright() as p:
    browser = p.chromium.launch()
    mctx = browser.new_context(viewport={"width": 1440, "height": 900})
    m = sign_in(mctx, "Hana Farouk", "/overview")

    # ── 1. A teacher nobody used: deleted at once, restored from Deleted items ──
    m.goto(f"{BASE}/settings/teachers")
    m.get_by_role("button", name=f"Delete {NEW}").click()
    d = m.get_by_role("dialog", name="Delete teacher")
    expect(d.get_by_test_id("delete-summary")).to_contain_text("This deletes: 1 teacher, 1 rate.")
    d.get_by_label("Reason").fill("Added by mistake")
    d.get_by_role("button", name="Delete", exact=True).click()
    expect(m.get_by_text("Deleted. You can restore it from Settings → Deleted items within 30 days.")).to_be_visible()
    expect(m.locator(f"[data-teacher='{NEW}']")).to_have_count(0)
    check("A teacher nobody used is deleted with their rate and leaves the list", not exists("teachers", t) and not exists("teacher_rates", r))
    m.goto(f"{BASE}/settings/deleted")
    item = m.locator("[data-deleted-item]").filter(has_text=NEW)
    expect(item).to_contain_text("Teacher")
    item.get_by_role("button", name="Restore").click()
    expect(m.get_by_text("Teacher restored.")).to_be_visible()
    m.goto(f"{BASE}/settings/teachers")
    expect(m.locator(f"[data-teacher='{NEW}']")).to_be_visible()
    check("Restored, with the same id and rate", exists("teachers", t) and exists("teacher_rates", r))

    # ── 2. A teacher already used: Not active instead ──────────────────────
    m.get_by_role("button", name="Delete Dina Kamal").click()
    d = m.get_by_role("dialog", name="Delete teacher")
    alert = d.get_by_role("alert")
    expect(alert).to_contain_text("Already used: 1 customer")
    shot(m, "01-teacher-used")
    check("A used teacher cannot be deleted: no reason box, no Delete", d.get_by_label("Reason").count() == 0 and d.get_by_role("button", name="Delete", exact=True).is_disabled())
    d.get_by_role("button", name="Set Not active instead").click()
    expect(m.get_by_text("Teacher set to Not active. Their history is kept.")).to_be_visible()
    check("…and is set to Not active, keeping the history", sql("select active from public.teachers where id = $1", [dina])[0]["active"] is False and exists("teachers", dina))

    # ── 3. A rate already used: Archive instead ────────────────────────────
    m.locator("[data-teacher='Ahmed Sami']").get_by_role("button", name="Delete SAT group").click()
    d = m.get_by_role("dialog", name="Delete rate")
    expect(d.get_by_role("alert")).to_contain_text("Already used: 1 group course")
    d.get_by_role("button", name="Archive instead").click()
    expect(m.get_by_text("Rate archived. Past hours keep it.")).to_be_visible()
    check("A used rate is archived instead", sql("select archived from public.teacher_rates where id = $1", [sami_group])[0]["archived"] is True)
    audit = [a["action"] for a in sql("select action from public.audit_log where action in ('Deleted teacher (Added by mistake)', 'Restored teacher') order by created_at")]
    check("The delete and restore are in the audit history", audit == ["Deleted teacher (Added by mistake)", "Restored teacher"], json.dumps(audit))

    # ── 4. Phone ───────────────────────────────────────────────────────────
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Hana Farouk", "/overview")
    mp.goto(f"{BASE}/settings/teachers")
    mp.get_by_role("button", name=f"Delete {NEW}").click()
    expect(mp.get_by_role("dialog", name="Delete teacher").get_by_test_id("delete-summary")).to_be_visible()
    check("The dialog fits a phone", not mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    shot(mp, "02-phone", full=True)
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
