import { describe, expect, it } from "vitest";
import { academyMonth, daysBetween, periodRange, sumByCurrency } from "./accounting";

describe("Academy month (26th to 25th)", () => {
  it("is named after the month it ends in", () => {
    expect(academyMonth("2026-10-22")).toEqual({ from: "2026-09-26", to: "2026-10-25", label: "October 2026" });
    expect(academyMonth("2026-10-25")).toEqual({ from: "2026-09-26", to: "2026-10-25", label: "October 2026" });
    expect(academyMonth("2026-10-26")).toEqual({ from: "2026-10-26", to: "2026-11-25", label: "November 2026" });
  });
  it("crosses the year correctly", () => {
    expect(academyMonth("2026-12-27")).toEqual({ from: "2026-12-26", to: "2027-01-25", label: "January 2027" });
    expect(academyMonth("2027-01-05")).toEqual({ from: "2026-12-26", to: "2027-01-25", label: "January 2027" });
    expect(academyMonth("2027-01-05", -1)).toEqual({ from: "2026-11-26", to: "2026-12-25", label: "December 2026" });
  });
  it("handles February", () => {
    expect(academyMonth("2027-03-01")).toEqual({ from: "2027-02-26", to: "2027-03-25", label: "March 2027" });
  });
});

describe("periods", () => {
  const c = { from: "2026-01-01", to: "2026-01-31" };
  it("this week starts on Sunday", () => {
    expect(periodRange("week", "2026-10-22", c)).toEqual({ from: "2026-10-18", to: "2026-10-22" }); // a Thursday
    expect(periodRange("week", "2026-10-18", c)).toEqual({ from: "2026-10-18", to: "2026-10-18" });
  });
  it("this Academy month stops at today; last one is whole", () => {
    expect(periodRange("academy", "2026-10-22", c)).toEqual({ from: "2026-09-26", to: "2026-10-22" });
    expect(periodRange("last_academy", "2026-10-22", c)).toEqual({ from: "2026-08-26", to: "2026-09-25" });
  });
  it("today, this month, custom", () => {
    expect(periodRange("today", "2026-10-22", c)).toEqual({ from: "2026-10-22", to: "2026-10-22" });
    expect(periodRange("month", "2026-10-22", c)).toEqual({ from: "2026-10-01", to: "2026-10-22" });
    expect(periodRange("custom", "2026-10-22", c)).toEqual(c);
  });
  it("lists days inclusively", () => {
    expect(daysBetween("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  });
});

describe("money totals", () => {
  it("never add currencies together", () => {
    expect(sumByCurrency([{ amount: 100, currency: "EGP" }, { amount: 20, currency: "USD" }, { amount: 50.5, currency: "EGP" }]))
      .toEqual([{ currency: "EGP", amount: 150.5 }, { currency: "USD", amount: 20 }]);
  });
});
