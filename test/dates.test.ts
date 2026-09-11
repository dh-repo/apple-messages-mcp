import { describe, expect, it } from "vitest";
import { appleDateToIso, isoToAppleNanos } from "../src/db/dates.ts";

describe("apple dates", () => {
  it("round-trips an ISO timestamp through nanoseconds", () => {
    const iso = "2026-03-01T18:00:00.000Z";
    expect(appleDateToIso(isoToAppleNanos(iso))).toBe(iso);
  });

  it("accepts legacy second-resolution dates", () => {
    const seconds = 24 * 3600;
    expect(appleDateToIso(seconds)).toBe("2001-01-02T00:00:00.000Z");
  });

  it("returns null for empty dates", () => {
    expect(appleDateToIso(0)).toBeNull();
    expect(appleDateToIso(null)).toBeNull();
  });
});
