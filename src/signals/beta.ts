// anthropic-beta header → sorted, trimmed, deduped string list.

type HeaderValue = string | readonly string[] | undefined;

function toLines(raw: HeaderValue): readonly string[] {
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
  return [];
}

export function extractBetaFlags(
  headers: Readonly<Record<string, string | readonly string[] | undefined>> | undefined,
): readonly string[] {
  if (!headers) return Object.freeze([]);
  const raw: HeaderValue = headers['anthropic-beta'] ?? headers['Anthropic-Beta'];
  const lines = toLines(raw);
  const out = new Set<string>();
  for (const line of lines) {
    for (const part of line.split(',')) {
      const trimmed = part.trim();
      if (trimmed.length > 0) out.add(trimmed);
    }
  }
  return Object.freeze(Array.from(out).sort());
}
