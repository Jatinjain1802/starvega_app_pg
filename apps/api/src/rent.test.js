import { describe, expect, it } from "vitest";
import { dueDateSchema, monthSchema, monthStart } from "./rent.js";

describe("rent period validation", () => {
  it("accepts a calendar month and converts it to the database month start", () => {
    const month = monthSchema.parse("2026-11");
    expect(monthStart(month)).toBe("2026-11-01");
  });

  it("rejects invalid month values", () => {
    expect(monthSchema.safeParse("2026-13").success).toBe(false);
    expect(monthSchema.safeParse("November 2026").success).toBe(false);
  });

  it("accepts only real ISO due dates", () => {
    expect(dueDateSchema.safeParse("2026-11-30").success).toBe(true);
    expect(dueDateSchema.safeParse("2026-02-30").success).toBe(false);
  });
});
