"""
Console scan: opens every screen, panel tab and main dialog as each role and fails on ANY browser
console error or warning (React hydration mismatches, invalid HTML nesting, missing keys, failed
requests, uncaught exceptions).

Run it against the app in DEVELOPMENT mode (`npm run dev`), where React reports these problems;
the production build hides them. Freshly seeded local data:
  python3 tests/e2e/console_scan.py
"""
import re
import sys

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
# Development-only noise that is not a problem in the app.
IGNORE = re.compile(r"Download the React DevTools|\[HMR\]|\[Fast Refresh\]|webpack-hmr|turbopack-hmr|_next/webpack-hmr")

problems = []
visited = 0


def attach(page, who):
    def on_console(msg):
        if msg.type in ("error", "warning") and not IGNORE.search(msg.text):
            problems.append(f"{who} · {page.url.replace(BASE, '')} · console {msg.type}: {msg.text[:400]}")

    page.on("console", on_console)
    page.on("pageerror", lambda e: problems.append(f"{who} · {page.url.replace(BASE, '')} · uncaught: {str(e)[:400]}"))
    page.on("response", lambda r: r.status >= 500 and problems.append(f"{who} · {r.url.replace(BASE, '')} · HTTP {r.status}"))


def step(label, fn):
    """Run one scan step; a step that cannot run is reported but does not stop the scan."""
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        problems.append(f"scan · step '{label}' could not run: {str(e).splitlines()[0][:200]}")


def settle(page):
    try:
        page.wait_for_load_state("networkidle", timeout=60000)
    except Exception:  # noqa: BLE001 — a slow first compile in development mode is not a page problem
        pass
    page.wait_for_timeout(700)


def visit(page, path):
    global visited
    page.goto(BASE + path)
    settle(page)
    visited += 1


def open_and_close(page, button_name, dialog_name=None, scope=None, exact=False):
    """Click a button that opens a dialog, wait, then close it with Escape."""
    global visited
    where = scope or page
    btn = where.get_by_role("button", name=button_name, exact=exact).first
    if not btn.count() or not btn.is_visible() or not btn.is_enabled():
        problems.append(f"scan · {page.url.replace(BASE, '')} · could not find button '{button_name}'")
        return
    btn.click()
    if dialog_name:
        page.get_by_role("dialog", name=dialog_name).wait_for()
    page.wait_for_timeout(500)
    visited += 1
    # Close only the dialog (Escape could also close the customer panel behind it).
    dialogs = page.get_by_role("dialog").filter(has_not_text="Customer details")
    cancel = page.get_by_role("button", name=re.compile(r"^(Cancel|Close|Not now)$")).last
    if cancel.count() and cancel.is_visible():
        cancel.click()
    else:
        page.keyboard.press("Escape")
    page.wait_for_timeout(300)


def open_panel(page, list_path, name, index=0):
    visit(page, list_path)
    page.locator("main").get_by_role("button", name=name).nth(index).click()
    panel = page.get_by_role("dialog", name="Customer details")
    panel.wait_for()
    settle(page)
    return panel


def tabs(page, panel):
    global visited
    for t in panel.get_by_role("tab").all():
        t.click()
        page.wait_for_timeout(500)
        visited += 1


with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── Manager ──────────────────────────────────────────────────────────
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    m = ctx.new_page()
    attach(m, "Manager")
    visit(m, "/login")
    m.get_by_role("button", name="Hana Farouk").click()
    m.wait_for_url("**/overview*", timeout=120000)
    settle(m)
    for path in ["/overview", "/leads", "/payments", "/customers", "/reports", "/review", "/follow-ups", "/settings"]:
        visit(m, path)
    for section in ["users", "shifts", "courses", "fields", "stages", "tags", "followups", "notifications", "payments", "checklist", "sheets", "audit"]:
        visit(m, f"/settings/{section}")
    visit(m, "/settings/users"); open_and_close(m, "Add user"); open_and_close(m, "Set password")
    visit(m, "/settings/courses"); open_and_close(m, "Add course"); open_and_close(m, "Add type")
    visit(m, "/settings/checklist"); open_and_close(m, "Add step")
    visit(m, "/settings/sheets"); open_and_close(m, "Connect Google Sheet")
    visit(m, "/leads"); open_and_close(m, "Filters", "Filters"); open_and_close(m, "Add customer")
    visit(m, "/payments")
    for t in ["Confirmed", "Rejected and reversed", "To confirm"]:
        m.get_by_role("tab", name=re.compile(t)).click(); m.wait_for_timeout(500); visited += 1
    open_and_close(m, "Reject", "Reject payment")
    visit(m, "/reports")
    m.get_by_label("Date range").select_option("custom"); m.wait_for_timeout(600)
    m.get_by_label("Date range").select_option("90"); m.wait_for_timeout(600); visited += 2
    for name in ["Hoda Salem", "Sara Nasser", "Jana Ezzat"]:
        def mgr_panel(name=name):
            panel = open_panel(m, "/leads", name)
            tabs(m, panel)
            m.keyboard.press("Escape")
        step(f"manager panel ({name})", mgr_panel)
    m.get_by_role("button", name=re.compile("Notifications")).first.click(); m.wait_for_timeout(500); visited += 1

    # ── Sales ────────────────────────────────────────────────────────────
    sctx = browser.new_context(viewport={"width": 1440, "height": 900})
    s = sctx.new_page()
    attach(s, "Sales")
    visit(s, "/login")
    s.get_by_role("button", name="Nour Hassan").click()
    s.wait_for_url("**/my-work*", timeout=120000)
    settle(s)
    for path in ["/my-work", "/leads", "/follow-ups"]:
        visit(s, path)
    def nadine():
        panel = open_panel(s, "/leads", "Nadine Wahba")
        tabs(s, panel)
        panel.get_by_role("tab", name="activity").click()
        open_and_close(s, "Record outcome", scope=panel)
        panel.get_by_role("button", name="Add note").first.click(); s.wait_for_timeout(400)  # focuses the note box, not a dialog
        open_and_close(s, "Set follow-up", scope=panel)
        panel.get_by_role("tab", name="payments").click(); s.wait_for_timeout(400)
        open_and_close(s, "Start enrollment", scope=panel)

    def hoda():
        # Hoda has two inquiries (Ali and Salma); the one with an enrollment has Submit payment.
        for i in range(2):
            panel = open_panel(s, "/leads", "Hoda Salem", i)
            panel.get_by_role("tab", name="payments").click(); s.wait_for_timeout(400)
            if panel.get_by_role("button", name="Submit payment").count():
                open_and_close(s, "Submit payment", scope=panel)
                return
        raise RuntimeError("no Hoda inquiry with Submit payment")

    step("sales panel and dialogs (Nadine)", nadine)
    step("sales payment dialog (Hoda)", hoda)

    # ── Support ──────────────────────────────────────────────────────────
    uctx = browser.new_context(viewport={"width": 1440, "height": 900})
    u = uctx.new_page()
    attach(u, "Support")
    visit(u, "/login")
    u.get_by_role("button", name="Laila Ibrahim").click()
    u.wait_for_url("**/my-work*", timeout=120000)
    settle(u)
    for path in ["/my-work", "/customers", "/follow-ups"]:
        visit(u, path)
    def sara():
        panel = open_panel(u, "/customers", "Sara Nasser")
        tabs(u, panel)
        panel.get_by_role("tab", name="support").click(); u.wait_for_timeout(400)
        open_and_close(u, "Add", scope=panel, exact=True)

    step("support panel (Sara)", sara)

    # ── Phone width ──────────────────────────────────────────────────────
    mob = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = mob.new_page()
    attach(mp, "Manager (phone)")
    visit(mp, "/login")
    mp.get_by_role("button", name="Hana Farouk").click()
    mp.wait_for_url("**/overview*", timeout=120000)
    for path in ["/overview", "/leads", "/payments", "/reports", "/settings", "/settings/sheets"]:
        visit(mp, path)

    # ── Clock skew: the browser's clock 3 minutes ahead of the server ────
    # Reproduces every time what otherwise only happens at a minute boundary: any time shown on
    # the page must come from the server's clock on the first render, or hydration fails.
    import time as _time
    skew = browser.new_context(viewport={"width": 1440, "height": 900})
    sk = skew.new_page()
    sk.clock.install(time=_time.time() + 180)
    attach(sk, "Clock-skewed browser")
    visit(sk, "/login")
    sk.get_by_role("button", name="Hana Farouk").click()
    sk.wait_for_url("**/overview*", timeout=120000)
    for path in ["/overview", "/reports", "/payments", "/customers", "/settings/audit"]:
        visit(sk, path)
    ssk = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
    ssk.clock.install(time=_time.time() + 180)
    attach(ssk, "Clock-skewed browser")
    visit(ssk, "/login")
    ssk.get_by_role("button", name="Laila Ibrahim").click()
    ssk.wait_for_url("**/my-work*", timeout=120000)
    for path in ["/my-work", "/customers"]:
        visit(ssk, path)
    browser.close()

unique = list(dict.fromkeys(problems))
for line in unique:
    print("PROBLEM", line)
print(f"\n{visited} screens, tabs and dialogs checked · {len(unique)} console problem(s)")
sys.exit(1 if unique else 0)
