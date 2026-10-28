/** Search in long lists (plan 3, release 1): Arabic and English matching and reading select options. */
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { matches, optionsOf, searchText, textOf } from "./search-text";

describe("matching", () => {
  it("ignores case, extra spaces and the order of words", () => {
    expect(matches("Ahmed Sami · SAT private", "sat  AHMED")).toBe(true);
    expect(matches("Ahmed Sami", "sami ali")).toBe(false);
    expect(matches("Anything", "   ")).toBe(true);
  });

  it("treats Arabic letter variants and diacritics alike", () => {
    expect(matches("أحمد علي", "احمد")).toBe(true);
    expect(matches("إيمان", "ايمان")).toBe(true);
    expect(matches("مُصْطَفَى", "مصطفي")).toBe(true);
    expect(matches("مدرسة", "مدرسه")).toBe(true);
    expect(searchText("ســـارة")).toBe("ساره");
    expect(matches("Group ٣", "3")).toBe(true);
  });
});

describe("reading a select's choices", () => {
  it("finds options inside groups and fragments, with their text", () => {
    const children = [
      h("option", { key: "a", value: "" }, "Nobody"),
      h("optgroup", { key: "b", label: "SAT" }, h("option", { value: "c1" }, "Course ", 1, " · 10,000 EGP")),
      h("optgroup", { key: "c", label: "IELTS" }, [h("option", { key: "x", value: "c2", disabled: true }, "Closed course")]),
    ];
    expect(optionsOf(children)).toEqual([
      { value: "", label: "Nobody", group: undefined, disabled: false },
      { value: "c1", label: "Course 1 · 10,000 EGP", group: "SAT", disabled: false },
      { value: "c2", label: "Closed course", group: "IELTS", disabled: true },
    ]);
    expect(textOf(h("span", null, h("b", null, "Tag"), " name"))).toBe("Tag name");
  });
});
