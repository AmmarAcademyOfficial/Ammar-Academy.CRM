"""
Staff passwords (manager): the Add user dialog with "Set a password now", the Set password dialog,
their validation, and that only managers can use them.

Local sign-in has no passwords, so this checks the screens, the rules and the permissions. Setting a
real password goes through Supabase's admin API and is checked once on the live server.
  python3 tests/e2e/passwords_e2e.py
Synthetic data only.
"""
import re
import sys

from playwright.sync_api import expect, sync_playwright

PW = re.compile(r"^Password")
BASE = "http://localhost:3000"
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""))
    if not cond:
        raise SystemExit(1)


def sign_in(ctx, name, path):
    page = ctx.new_page()
    page.goto(f"{BASE}/login")
    page.get_by_role("button", name=name).click()
    page.wait_for_url(f"**{path}*")
    return page


with sync_playwright() as p:
    browser = p.chromium.launch()
    m = sign_in(browser.new_context(viewport={"width": 1440, "height": 900}), "Hana Farouk", "/overview")
    m.goto(f"{BASE}/settings/users")

    # Add user: "Set a password now" is the default and checks the password before saving.
    m.get_by_role("button", name="Add user").click()
    dlg = m.get_by_role("dialog", name="Add a staff member")
    expect(dlg).to_be_visible()
    check("Add user offers a password or an email invitation",
          dlg.get_by_label("Set a password now").is_checked() and dlg.get_by_label("Email them an invitation link").count() == 1)
    dlg.get_by_label("Full name").fill("Test Agent Passwords")
    dlg.get_by_label("Work email").fill("test.agent.passwords@example.com")
    dlg.get_by_label(PW).fill("short")
    dlg.get_by_label("Type the password again").fill("short")
    dlg.get_by_role("button", name="Create account").click()
    expect(dlg.get_by_role("alert")).to_have_text("Use at least 10 characters.")
    dlg.get_by_label(PW).fill("alllowercase123")
    dlg.get_by_label("Type the password again").fill("alllowercase123")
    dlg.get_by_role("button", name="Create account").click()
    expect(dlg.get_by_role("alert")).to_contain_text("uppercase")
    dlg.get_by_label(PW).fill("GoodPassword2026")
    dlg.get_by_label("Type the password again").fill("GoodPassword2027")
    dlg.get_by_role("button", name="Create account").click()
    expect(dlg.get_by_role("alert")).to_have_text("The two passwords do not match.")
    check("Weak or mismatched passwords are refused on screen", True)
    dlg.get_by_label("Show password").check()
    check("Show password reveals what was typed", dlg.get_by_label(PW).get_attribute("type") == "text")

    # Switching to the email invitation hides the password and creates the account (local mode: no email).
    dlg.get_by_label("Email them an invitation link").check()
    expect(dlg.get_by_label(PW)).to_have_count(0)
    dlg.get_by_role("button", name="Send invitation").click()
    expect(dlg).to_have_count(0)
    row = m.get_by_role("row").filter(has_text="Test Agent Passwords")
    expect(row).to_be_visible()
    check("A staff member can still be added by invitation", True)

    # Set password on a row: same rules; local sign-in refuses with a clear message.
    row.get_by_role("button", name="Set password for Test Agent Passwords").click()
    sp = m.get_by_role("dialog", name="Set a new password for Test Agent Passwords")
    expect(sp).to_be_visible()
    sp.get_by_label(PW).fill("NoDigitsHere")
    sp.get_by_label("Type the password again").fill("NoDigitsHere")
    sp.get_by_role("button", name="Save password").click()
    expect(sp.get_by_role("alert")).to_contain_text("number")
    sp.get_by_label(PW).fill("GoodPassword2026")
    sp.get_by_label("Type the password again").fill("GoodPassword2026")
    sp.get_by_role("button", name="Save password").click()
    expect(m.get_by_text("Passwords are not used with local sign-in.")).to_be_visible()
    check("Set password checks the rules and reaches the server", True)
    sp.get_by_role("button", name="Cancel").click()

    # Only managers see staff settings.
    s = sign_in(browser.new_context(), "Nour Hassan", "/my-work")
    s.goto(f"{BASE}/settings/users")
    check("Sales staff cannot open user settings", "/settings" not in s.url or s.get_by_role("button", name="Set password").count() == 0, s.url)

    # Phone width: the users table still fits with the new column.
    mob = sign_in(browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True), "Hana Farouk", "/overview")
    mob.goto(f"{BASE}/settings/users")
    mob.wait_for_load_state("networkidle")
    check("Users settings fit a phone screen", not mob.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} checks passed")
sys.exit(0)
