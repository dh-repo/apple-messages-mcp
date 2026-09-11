import { describe, expect, it } from "vitest";
import {
  decodeAttributedBody,
  encodeAttributedBody,
  resolveMessageText,
} from "../src/decode/attributedBody.ts";

describe("attributedBody", () => {
  it("round-trips a short NSString payload", () => {
    const blob = encodeAttributedBody("meet at 7");
    expect(decodeAttributedBody(blob)).toBe("meet at 7");
  });

  it("round-trips a payload longer than 0x80 bytes", () => {
    const text = "x".repeat(200);
    expect(decodeAttributedBody(encodeAttributedBody(text))).toBe(text);
  });

  it("returns null for empty input", () => {
    expect(decodeAttributedBody(null)).toBeNull();
    expect(decodeAttributedBody(Buffer.alloc(0))).toBeNull();
  });

  it("prefers the plain text column when present", () => {
    expect(resolveMessageText("hello", encodeAttributedBody("other"))).toEqual({
      text: "hello",
      source: "text",
    });
  });

  it("falls back to attributedBody when text is null", () => {
    expect(resolveMessageText(null, encodeAttributedBody("from blob"))).toEqual({
      text: "from blob",
      source: "attributedBody",
    });
  });

  it("marks attachment-only rows as none", () => {
    expect(resolveMessageText(null, null)).toEqual({ text: "", source: "none" });
  });
});
