"""
Step 2 browser test (22 Oct 2026): Settings → Notifications (on/off and pop-up per type and role,
timing), pop-ups with sound, mute, managers told about each new lead, and the timed alerts sent by
the 2-minute scheduler.

Runs against the production build and a freshly seeded local database:
  python3 tests/e2e/step2_e2e.py [screenshot_dir]
Synthetic data only.
"""
import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = "http://localhost:3000"
ROOT = Path(__file__).parents[2]
SHOTS = Path(sys.argv[1]) if len(sys.argv) > 1 else None
CRON_SECRET = "local-cron-secret-for-tests-only-0000"  # the local test value from run-browser-suites.sh, not a real secret
results = []

# Counts chimes: every oscillator the page starts.
COUNT_CHIMES = """
(() => {
  window.__oscillators = 0;
  const orig = AudioContext.prototype.createOscillator;
  AudioContext.prototype.createOscillator = function () { window.__oscillators++; return orig.call(this); };
})();
"""


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


def uid(name):
    return sql("select id from public.profiles where full_name = $1", [name])[0]["id"]


def refresh_bell(page):
    """The bell checks every 20 seconds; a window focus makes it check now."""
    page.evaluate("window.dispatchEvent(new Event('focus'))")


def rule(event, role, expect_value=None, page=None):
    """The saved rule; with expect_value, waits up to 5 seconds for the save to land."""
    for _ in range(25):
        r = sql("select enabled, popup from public.notification_rules where event = $1 and role = $2", [event, role])[0]
        if expect_value is None or r == expect_value:
            return r
        page.wait_for_timeout(200)
    return r


nour = uid("Nour Hassan")
hana = uid("Hana Farouk")

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])

    # ── 1. Settings → Notifications ─────────────────────────────────────────
    mctx = browser.new_context(viewport={"width": 1440, "height": 900})
    m = sign_in(mctx, "Hana Farouk", "/overview")
    m.goto(f"{BASE}/settings/notifications")
    expect(m.get_by_role("heading", name="Notifications")).to_be_visible()
    for title in ["Timing", "Leads", "Follow-ups", "Payments and support", "System"]:
        expect(m.get_by_text(title, exact=True).first).to_be_visible()
    check("The Notifications settings page lists every group", True)
    shot(m, "01-settings-notifications", full=True)

    switch = m.get_by_role("switch", name="Form submitted again: notify sales agents")
    expect(switch).to_have_attribute("aria-checked", "true")
    switch.click()
    expect(switch).to_have_attribute("aria-checked", "false")
    popup_box = m.get_by_label("Form submitted again: pop-up and sound for sales agents")
    expect(popup_box).to_be_disabled()
    check("Switching a type off for a role is saved", rule("form_resubmitted", "sales", {"enabled": False, "popup": True}, m) == {"enabled": False, "popup": True})
    switch.click()
    expect(switch).to_have_attribute("aria-checked", "true")
    check("...and back on, keeping its pop-up choice", rule("form_resubmitted", "sales", {"enabled": True, "popup": True}, m) == {"enabled": True, "popup": True})

    handed = m.get_by_label("Customer handed over to support: pop-up and sound for sales agents")
    expect(handed).not_to_be_checked()
    handed.check()
    expect(handed).to_be_checked()
    check("The pop-up choice is saved per role", rule("handed_over", "sales", {"enabled": True, "popup": True}, m)["popup"] is True)
    handed.uncheck()
    rule("handed_over", "sales", {"enabled": True, "popup": False}, m)

    minutes = m.get_by_label("Alert when a new lead is not opened after")
    expect(minutes).to_have_value("30")
    minutes.fill("45")
    minutes.blur()
    m.wait_for_timeout(800)
    check("The not-opened alert time is saved", sql("select unopened_alert_minutes as n from public.app_settings")[0]["n"] == 45)
    m.reload()
    m.get_by_label("Alert when a new lead is not opened after").fill("30")
    m.get_by_label("Alert when a new lead is not opened after").blur()
    m.wait_for_timeout(800)
    audit = sql("select count(*)::int as n from public.audit_log where action = 'Changed notification setting' and actor_id = $1", [hana])[0]["n"]
    check("Changes are recorded in the audit history", audit >= 4, f"{audit} entries")

    # ── 2. Pop-up with sound for the agent ──────────────────────────────────
    sctx = browser.new_context(viewport={"width": 1440, "height": 900})
    sctx.add_init_script(COUNT_CHIMES)
    s = sign_in(sctx, "Nour Hassan", "/my-work")
    s.mouse.click(700, 120)  # any click unlocks sound, as in a real visit
    s.wait_for_timeout(1500)
    lead = sql("""select i.id, c.name from public.inquiries i join public.contacts c on c.id = i.contact_id
                  where i.sales_owner_id = $1 order by i.created_at desc limit 1""", [nour])[0]
    sql("insert into public.notifications (user_id, text, inquiry_id) values ($1, $2, $3)", [nour, f"Lead assigned to you: {lead['name']}", lead["id"]])
    sql("insert into public.notifications (user_id, text, inquiry_id) values ($1, $2, $3)", [nour, f"Enrolled and handed over to support: {lead['name']}", lead["id"]])
    refresh_bell(s)
    pop = s.locator("[data-popup=lead_assigned]")
    expect(pop).to_be_visible(timeout=25_000)
    expect(pop).to_contain_text(lead["name"])
    check("A new lead pops up for the agent", True)
    check("...with a sound", s.evaluate("window.__oscillators") >= 2, f"{s.evaluate('window.__oscillators')} tones")
    check("Types without pop-up stay in the bell only", s.locator("[data-popup=handed_over]").count() == 0
          and s.get_by_role("button", name=re.compile(r"Notifications, \d+ unread")).count() == 1)
    shot(s, "02-popup")
    pop.get_by_role("button", name="Open").click()
    expect(s.get_by_role("dialog", name="Customer details")).to_be_visible()
    check("Open on the pop-up opens the lead", pop.count() == 0)
    s.keyboard.press("Escape")

    # Mute from the bell: the next pop-up is silent.
    s.get_by_role("button", name=re.compile("^Notifications")).click()
    s.get_by_role("button", name="Pop-up sound on. Turn off").click()
    expect(s.get_by_role("button", name="Pop-up sound off. Turn on")).to_have_attribute("aria-pressed", "false")
    shot(s, "03-bell-menu")
    s.keyboard.press("Escape")
    before = s.evaluate("window.__oscillators")
    sql("insert into public.notifications (user_id, text, inquiry_id) values ($1, $2, $3)", [nour, f"Submitted the form again: {lead['name']}", lead["id"]])
    refresh_bell(s)
    expect(s.locator("[data-popup=form_resubmitted]")).to_be_visible(timeout=25_000)
    check("Muted: the pop-up still shows, without sound", s.evaluate("window.__oscillators") == before)
    s.reload()
    s.get_by_role("button", name=re.compile("^Notifications")).click()
    check("The mute choice is remembered after a reload", s.get_by_role("button", name="Pop-up sound off. Turn on").count() == 1)
    s.keyboard.press("Escape")

    # ── 3. Managers: a pop-up for each new lead ─────────────────────────────
    m.goto(f"{BASE}/overview")
    m.wait_for_timeout(1500)
    program = sql("select id from public.programs where code = 'SAT'")[0]["id"]
    contact = sql("insert into public.contacts (name, phone, phone_normalized) values ('Step Two Newcomer', '+201099990001', '+201099990001') returning id")[0]["id"]
    inq = sql("""insert into public.inquiries (contact_id, program_id, stage_id, source) values ($1, $2,
                 (select id from public.stages where system_key = 'new'), 'google_sheet') returning id""", [contact, program])[0]["id"]
    refresh_bell(m)
    mpop = m.locator("[data-popup=new_lead]").filter(has_text="Step Two Newcomer")
    expect(mpop).to_be_visible(timeout=25_000)
    expect(mpop).to_contain_text("New lead: Step Two Newcomer (SAT, Google Sheet)")
    check("Managers get a pop-up for each new lead", True)
    shot(m, "04-manager-new-lead")

    # ── 4. Timed alerts from the 2-minute scheduler ─────────────────────────
    target = sql("""select i.id, c.name from public.inquiries i join public.contacts c on c.id = i.contact_id
                    join public.stages st on st.id = i.stage_id
                    where i.sales_owner_id = $1 and not st.is_closed order by i.created_at desc offset 1 limit 1""", [nour])[0]
    sql("update public.inquiries set owner_opened_at = null, unopened_alert_at = null, assigned_at = now() - interval '40 minutes' where id = $1", [target["id"]])
    sql("insert into public.follow_ups (inquiry_id, owner_id, due_at, note, created_by) values ($1, $2, now() + interval '10 minutes', 'Step two reminder', $2)", [target["id"], nour])
    req = urllib.request.Request(f"{BASE}/api/cron/tick", method="POST", headers={"Authorization": f"Bearer {CRON_SECRET}"})
    tick = json.loads(urllib.request.urlopen(req, timeout=120).read())
    check("The scheduler sends the timed alerts", tick.get("alerts", {}).get("unopened", 0) >= 1 and tick["alerts"]["reminders"] >= 1, json.dumps(tick.get("alerts")))
    texts = [r["text"] for r in sql("select text from public.notifications where user_id = $1 and inquiry_id = $2", [nour, target["id"]])]
    check("The agent is told the lead is not opened yet", any(t == f"Not opened yet: {target['name']} was assigned to you 30 minutes ago." for t in texts), str(texts))
    check("The follow-up reminder is sent", any(re.match(rf"^Follow-up due at \d{{1,2}}:\d\d [AP]M: {re.escape(target['name'])} · Step two reminder$", t) for t in texts), str(texts))
    check("Managers are told too", sql("select count(*)::int as n from public.notifications where user_id = $1 and inquiry_id = $2 and kind = 'lead_not_opened_manager'", [hana, target["id"]])[0]["n"] == 1)

    # ── 5. Phone layout ─────────────────────────────────────────────────────
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = sign_in(mob, "Hana Farouk", "/overview")
    mp.goto(f"{BASE}/settings/notifications")
    mp.wait_for_load_state("networkidle")
    check("Notification settings fit a phone screen", not mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    shot(mp, "05-phone-settings", full=True)
    mp.wait_for_timeout(1500)
    sql("insert into public.notifications (user_id, text) values ($1, 'Google Sheets stopped syncing: the Google sign-in needs to be reconnected (Settings → Google Sheets Connections).')", [hana])
    refresh_bell(mp)
    ppop = mp.locator("[data-popup=sheet_problem]")
    expect(ppop).to_be_visible(timeout=25_000)
    box = ppop.bounding_box()
    nav_top = mp.locator("nav[aria-label=Main]").last.bounding_box()["y"]
    check("On phones the pop-up fits and sits above the bottom menu", box["x"] >= 0 and box["x"] + box["width"] <= 390 and box["y"] + box["height"] <= nav_top)
    shot(mp, "06-phone-popup")
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
