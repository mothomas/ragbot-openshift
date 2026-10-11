import { describe, expect, it } from "vitest";
import { fmt } from "./format";

// lib/format.test.ts's percent and number cases build their expectation from the same Intl call
// fmt() makes. These assert what each option is for instead, in a way that holds in any locale:
// nothing pins one, and the page takes the reader's.
const digits = (s: string) => s.replace(/\D/g, "");

describe("fmt's number options", () => {
  it("rounds a percent to one decimal, not to a whole number and not to more", () => {
    expect(fmt(12.34, "percent")).toBe(fmt(12.3, "percent"));
    expect(fmt(12.36, "percent")).toBe(fmt(12.4, "percent"));
    expect(fmt(12.3, "percent")).not.toBe(fmt(12, "percent"));
  });

  it("rounds a plain number to two decimals, not one and not three", () => {
    // the one absolute assertion in this file: one decimal would give 12346, three 1234568
    expect(digits(fmt(1234.5678))).toBe("123457");
    expect(fmt(1234.5678)).toBe(fmt(1234.57));
  });

  it("leaves a number alone when no currency is known", () => {
    expect(fmt(1200, "currency")).toBe(fmt(1200));
  });
});
