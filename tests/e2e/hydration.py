"""
Import this first in every browser test: after any full page load (goto, reload, wait_for_url), wait
until the app marks the page as interactive (<html data-hydrated>, set by HydrationMark). A click
that lands before React has hydrated does nothing, which made checks fail now and then on slower
machines such as GitHub's.
"""
from playwright.sync_api import Page

READY = "html[data-hydrated]"


def wait_ready(page: Page, timeout: float = 30000):
    try:
        page.wait_for_selector(READY, state="attached", timeout=timeout)
    except Exception:
        pass  # pages outside the app (or errors) are left to the test's own expectations


def _wrap(name):
    original = getattr(Page, name)

    def patched(self, *args, **kwargs):
        result = original(self, *args, **kwargs)
        wait_ready(self)
        return result

    patched.__name__ = name
    setattr(Page, name, patched)


for _name in ("goto", "reload", "wait_for_url", "go_back"):
    _wrap(_name)
