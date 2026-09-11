import { encodeAttributedBody } from "../../src/decode/attributedBody.ts";

/**
 * A streamtyped / NSAttributedString wrapper around an NSString payload.
 * Closer to a Tahoe Messages blob than the bare encoder helper alone.
 */
export function tahoeTypedstream(text: string): Buffer {
  const inner = encodeAttributedBody(text);
  return Buffer.concat([
    Buffer.from("streamtyped", "ascii"),
    Buffer.from([0x00, 0x84, 0x01, 0x40]),
    Buffer.from("NSAttributedString", "ascii"),
    Buffer.from([0x00, 0x84, 0x84]),
    Buffer.from("NSMutableAttributedString", "ascii"),
    inner,
    Buffer.from([0x00, 0x86]),
  ]);
}

export const TAHOE_SAMPLE_TEXT = "Tahoe fixture: pick up bagels";
export const TAHOE_SAMPLE_BLOB = tahoeTypedstream(TAHOE_SAMPLE_TEXT);
