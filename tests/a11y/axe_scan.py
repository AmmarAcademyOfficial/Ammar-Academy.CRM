"""
Accessibility scan (axe-core, WCAG 2.1 A/AA rules) of every main screen, for each role.
Run against the production build with freshly seeded data:  python3 tests/a11y/axe_scan.py
Prints each violation; exits 1 if any serious or critical one is found.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright
sys.path.insert(0, str(Path(__file__).parents[1] / "e2e"))
import hydration  # noqa: F401,E402  (waits for the page to be interactive after each load)

BASE = "http://localhost:3000"
AXE = (Path(__file__).parents[2] / "node_modules/axe-core/axe.min.js").read_text()
SCREENS = {
    "Hana Farouk": ["/overview", "/leads", "/payments", "/customers", "/reports", "/review", "/follow-ups",
                    "/settings/users", "/settings/shifts", "/settings/courses", "/settings/checklist",
                    "/settings/payments", "/settings/sheets", "/settings/audit", "/settings/teachers", "/sessions",
                    "/accounting", "/accounting?tab=payments", "/accounting?tab=customers", "/accounting?tab=agents", "/accounting?tab=teachers"],
    "Nour Hassan": ["/my-work", "/leads", "/follow-ups"],
    "Laila Ibrahim": ["/my-work", "/customers", "/follow-ups", "/sessions"],
    "Karim Fawzy": ["/accounting", "/accounting?tab=teachers"],
}
NO_PANEL = {"Karim Fawzy"}  # accountants open customers from Accounting, not the lead list
bad = 0
total = 0
with sync_playwright() as p:
    browser = p.chromium.launch()
    for person, paths in SCREENS.items():
        page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
        page.goto(f"{BASE}/login")
        page.get_by_role("button", name=person).click()
        page.wait_for_load_state("networkidle")
        for path in paths + ([] if person in NO_PANEL else ["__panel__"]):
            if path == "__panel__":
                page.goto(f"{BASE}/leads" if person != "Laila Ibrahim" else f"{BASE}/customers")
                page.wait_for_load_state("networkidle")
                page.locator("main button").filter(has_text="Sara Nasser").first.click()
                page.get_by_role("dialog", name="Customer details").wait_for()
                label = "customer panel"
            else:
                page.goto(BASE + path)
                label = path
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(400)
            page.add_script_tag(content=AXE)
            res = page.evaluate("""() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa'] } })
                                     .then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, sample: v.nodes[0].target.join(' ') })))""")
            total += 1
            for v in res:
                serious = v["impact"] in ("serious", "critical")
                bad += serious
                print(f"{'FAIL' if serious else 'note'} {person} {label}: [{v['impact']}] {v['id']} — {v['help']} ({v['n']}×, e.g. {v['sample']})")
    browser.close()
print(f"\n{total} screens scanned · {bad} serious/critical issue types")
sys.exit(1 if bad else 0)
