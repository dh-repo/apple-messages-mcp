export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

export function handlesMatch(a: string, b: string): boolean {
  if (a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0) return true;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (da.length >= 7 && da === db) return true;
  if (da.length >= 10 && db.length >= 10 && (da.endsWith(db) || db.endsWith(da))) {
    return true;
  }
  return false;
}

export function looksLikeHandle(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.includes("@")) return true;
  const digits = digitsOnly(trimmed);
  return digits.length >= 7;
}
