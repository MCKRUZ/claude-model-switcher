// RFC 7230 hop-by-hop header filter with raw-header preservation and host rewrite.

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
]);

const UPSTREAM_HOST = 'api.anthropic.com';

function collectConnectionTokens(rawHeaders: readonly string[]): Set<string> {
  const tokens = new Set<string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (!name || value === undefined) continue;
    if (name.toLowerCase() !== 'connection') continue;
    for (const tok of value.split(',')) {
      const t = tok.trim().toLowerCase();
      if (t.length > 0) tokens.add(t);
    }
  }
  return tokens;
}

export interface RequestHeaderFilterResult {
  readonly rawHeaders: string[];
}

export function filterRequestHeaders(rawHeaders: readonly string[]): RequestHeaderFilterResult {
  const connTokens = collectConnectionTokens(rawHeaders);
  const out: string[] = [];
  let hostAppended = false;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (!name || value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (connTokens.has(lower)) continue;
    if (lower === 'content-length') continue;
    // Strip Expect: 100-continue. Claude SDKs don't send it; undici handles
    // its own request framing. Forwarding would require matching 100 semantics.
    if (lower === 'expect') continue;
    if (lower === 'x-ccmux-token') continue;
    if (lower === 'host') {
      out.push('host', UPSTREAM_HOST);
      hostAppended = true;
      continue;
    }
    out.push(name, value);
  }
  if (!hostAppended) out.push('host', UPSTREAM_HOST);
  return { rawHeaders: out };
}

export interface ResponseHeaderFilterResult {
  readonly rawHeaders: string[];
}

export function filterResponseHeaders(rawHeaders: readonly string[]): ResponseHeaderFilterResult {
  const connTokens = collectConnectionTokens(rawHeaders);
  const out: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (!name || value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (connTokens.has(lower)) continue;
    out.push(name, value);
  }
  return { rawHeaders: out };
}
