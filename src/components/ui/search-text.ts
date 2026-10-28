import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

/* Search helpers shared by the searchable lists (no browser code, so any component can use them). */

/** Lists longer than this get a search button (lists of 7 or fewer stay plain). */
export const SEARCH_FROM = 8;

/**
 * Text for matching, in Arabic and English: lower case, no Arabic diacritics or tatweel, and the
 * usual letter variants treated alike (أ إ آ ٱ → ا, ى → ي, ة → ه, ؤ → و, ئ → ي), Arabic digits as Latin.
 */
export function searchText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[ً-ٰٟـ̀-ͯ]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/\s+/g, " ")
    .trim();
}

/** Every word typed must appear somewhere in the text. */
export function matches(text: string, query: string): boolean {
  const q = searchText(query);
  if (!q) return true;
  const t = searchText(text);
  return q.split(" ").every((w) => t.includes(w));
}

/** The visible text of a React node (option labels are built from strings and numbers). */
export function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

interface Opt { value: string; label: string; group?: string; disabled: boolean }

/** The <option>s of a select, also inside <optgroup>s, in order. */
export function optionsOf(children: ReactNode, group?: string): Opt[] {
  const out: Opt[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<{ value?: string | number; children?: ReactNode; label?: string; disabled?: boolean }>;
    if (el.type === "option") {
      const label = textOf(el.props.children);
      out.push({ value: String(el.props.value ?? label), label, group, disabled: !!el.props.disabled });
    } else if (el.type === "optgroup") {
      out.push(...optionsOf(el.props.children, el.props.label));
    } else if (el.props.children) {
      out.push(...optionsOf(el.props.children, group)); // fragments
    }
  });
  return out;
}

