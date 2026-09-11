/** Stderr only. Never pass message bodies or attachment paths with user content. */
export function logInfo(event: string, extra: Record<string, unknown> = {}): void {
  const payload = { event, ...extra };
  console.error(`[apple-messages-mcp] ${JSON.stringify(payload)}`);
}
