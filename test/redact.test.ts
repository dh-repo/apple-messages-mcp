import { describe, expect, it } from "vitest";
import { maybeRedact, redactText } from "../src/redact.ts";

describe("redact", () => {
  it("counts unicode code points, not UTF-16 units", () => {
    expect(redactText("👍hi")).toBe("[redacted 3 chars]");
  });

  it("leaves text alone when redact is off", () => {
    expect(maybeRedact("secret", false)).toBe("secret");
  });
});
