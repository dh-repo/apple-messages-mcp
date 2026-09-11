/** Seconds between Unix epoch (1970-01-01) and Apple epoch (2001-01-01). */
export const APPLE_EPOCH_UNIX_SECONDS = 978_307_200;
const APPLE_EPOCH_MS = APPLE_EPOCH_UNIX_SECONDS * 1000;

/**
 * Messages.date is usually nanoseconds since 2001-01-01 UTC.
 * Those values exceed Number.MAX_SAFE_INTEGER, so callers must pass
 * a string/bigint from `CAST(date AS TEXT)` — never a raw JS number.
 * Older rows used seconds. Detect by magnitude.
 */
export function appleDateToIso(
  value: number | bigint | string | null | undefined,
): string | null {
  if (value === null || value === undefined || value === "") return null;

  let nanosOrSeconds: bigint;
  try {
    nanosOrSeconds = typeof value === "bigint" ? value : BigInt(value);
  } catch {
    return null;
  }
  if (nanosOrSeconds === 0n) return null;

  const abs = nanosOrSeconds < 0n ? -nanosOrSeconds : nanosOrSeconds;
  let unixMs: bigint;
  if (abs > 1_000_000_000_000_000n) {
    unixMs = BigInt(APPLE_EPOCH_MS) + nanosOrSeconds / 1_000_000n;
  } else if (abs > 1_000_000_000_000n) {
    unixMs = BigInt(APPLE_EPOCH_MS) + nanosOrSeconds / 1_000n;
  } else {
    unixMs = BigInt(APPLE_EPOCH_MS) + nanosOrSeconds * 1000n;
  }

  const date = new Date(Number(unixMs));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function isoToAppleNanos(iso: string): bigint {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ISO date: ${iso}`);
  }
  return BigInt(Math.round(ms - APPLE_EPOCH_MS)) * 1_000_000n;
}

export function isIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}
