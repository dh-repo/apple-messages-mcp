/**
 * Extract plain text from message.attributedBody.
 *
 * On modern macOS (Sonoma+ / Tahoe), `message.text` is often NULL and the
 * body lives in an NSArchiver typedstream blob. We do not depend on a full
 * typedstream library: locate the first NSString payload, which is what
 * Messages stores as the visible body.
 *
 * Format after the "NSString" marker: class metadata, then 0x2B ('+'),
 * then a length prefix, then UTF-8 bytes.
 */

const NSSTRING = Buffer.from("NSString", "ascii");

function isMostlyText(value: string): boolean {
  if (value.length === 0) return false;
  let printable = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      printable += 1;
    }
  }
  return printable / [...value].length >= 0.85;
}

function extractPrintable(buf: Buffer): string | null {
  const text = buf.toString("utf8").replace(/[^\P{C}\n\t]/gu, " ");
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length < 2) return null;
  return collapsed;
}

function readLength(buf: Buffer, start: number): { len: number; next: number } | null {
  if (start >= buf.length) return null;
  const first = buf[start];
  if (first === undefined) return null;
  if (first === 0x81) {
    const len = buf[start + 1];
    if (len === undefined) return null;
    return { len, next: start + 2 };
  }
  if (first === 0x82) {
    if (start + 2 >= buf.length) return null;
    return { len: buf.readUInt16LE(start + 1), next: start + 3 };
  }
  if (first === 0x83) {
    if (start + 3 >= buf.length) return null;
    return { len: buf.readUIntLE(start + 1, 3), next: start + 4 };
  }
  if (first === 0x84) {
    if (start + 4 >= buf.length) return null;
    return { len: buf.readUInt32LE(start + 1), next: start + 5 };
  }
  return { len: first, next: start + 1 };
}

export function decodeAttributedBodyDetailed(
  blob: Uint8Array | Buffer | null | undefined,
): { text: string | null; guessed: boolean } {
  if (!blob || blob.length === 0) return { text: null, guessed: false };
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);

  let i = buf.indexOf(NSSTRING);
  if (i < 0) return { text: extractPrintable(buf), guessed: true };

  i += NSSTRING.length;
  while (i < buf.length && buf[i] !== 0x2b) i += 1;
  if (i >= buf.length) return { text: extractPrintable(buf), guessed: true };
  i += 1;

  const parsed = readLength(buf, i);
  if (!parsed || parsed.len <= 0 || parsed.next + parsed.len > buf.length) {
    return { text: extractPrintable(buf), guessed: true };
  }

  const text = buf.toString("utf8", parsed.next, parsed.next + parsed.len);
  if (!isMostlyText(text)) return { text: extractPrintable(buf), guessed: true };
  return { text, guessed: false };
}

export function decodeAttributedBody(
  blob: Uint8Array | Buffer | null | undefined,
): string | null {
  return decodeAttributedBodyDetailed(blob).text;
}

/** Test helper: wrap a UTF-8 string in a minimal NSString-shaped blob. */
export function encodeAttributedBody(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.from("NSString", "ascii");
  const mid = Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]);
  let lenBuf: Buffer;
  if (payload.length < 0x81) {
    lenBuf = Buffer.from([payload.length]);
  } else if (payload.length <= 0xff) {
    lenBuf = Buffer.from([0x81, payload.length]);
  } else {
    lenBuf = Buffer.alloc(3);
    lenBuf[0] = 0x82;
    lenBuf.writeUInt16LE(payload.length, 1);
  }
  return Buffer.concat([Buffer.from([0x04]), header, mid, lenBuf, payload]);
}

export function resolveMessageText(
  text: string | null | undefined,
  attributedBody: Uint8Array | Buffer | null | undefined,
): { text: string; source: "text" | "attributedBody" | "guess" | "none" } {
  if (text !== null && text !== undefined && text.length > 0) {
    return { text, source: "text" };
  }
  const decoded = decodeAttributedBodyDetailed(attributedBody);
  if (decoded.text && decoded.guessed) return { text: decoded.text, source: "guess" };
  if (decoded.text) return { text: decoded.text, source: "attributedBody" };
  return { text: "", source: "none" };
}
