import { describe, expect, it } from "vitest";
import { handlesMatch, looksLikeHandle } from "../src/db/handles.ts";

describe("handles", () => {
  it("matches formatted phone numbers by digits", () => {
    expect(handlesMatch("+15551001001", "+1 (555) 100-1001")).toBe(true);
    expect(handlesMatch("5551001001", "+15551001001")).toBe(true);
  });

  it("matches emails case-insensitively", () => {
    expect(handlesMatch("Brian@example.com", "brian@example.com")).toBe(true);
  });

  it("does not match unrelated numbers", () => {
    expect(handlesMatch("+15551001001", "+15551001002")).toBe(false);
  });

  it("detects phone vs group-name targets", () => {
    expect(looksLikeHandle("+15551001001")).toBe(true);
    expect(looksLikeHandle("lynn@example.com")).toBe(true);
    expect(looksLikeHandle("Weekend Plans")).toBe(false);
  });
});
