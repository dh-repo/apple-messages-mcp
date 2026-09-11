export function redactText(text: string): string {
  const chars = [...text];
  return `[redacted ${chars.length} chars]`;
}

export function maybeRedact(text: string, redact: boolean): string {
  return redact ? redactText(text) : text;
}
