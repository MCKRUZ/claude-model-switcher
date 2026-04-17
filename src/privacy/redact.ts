// Header sanitizer. Shared by logger, error paths, and test assertions.

export const SANITIZABLE_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'x-api-key',
  'x-ccmux-token',
]);

const REDACTED = '[REDACTED]';

type HeaderValue = string | string[] | undefined;

export function sanitizeHeaders<H extends Record<string, HeaderValue>>(
  headers: H,
): H {
  const out: Record<string, HeaderValue> = {};
  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (value === undefined) {
      out[key] = undefined;
      continue;
    }
    const shouldRedact = SANITIZABLE_HEADER_NAMES.has(key.toLowerCase());
    if (!shouldRedact) {
      out[key] = value;
      continue;
    }
    out[key] = Array.isArray(value) ? [REDACTED] : REDACTED;
  }
  return out as H;
}
