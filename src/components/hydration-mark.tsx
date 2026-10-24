"use client";

import { useEffect } from "react";

/**
 * Marks the page as interactive once React has hydrated it (`<html data-hydrated>`). Browser tests
 * wait for this before clicking, because a click that lands before hydration does nothing.
 * No effect for staff.
 */
export function HydrationMark() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "1";
  }, []);
  return null;
}
