# Privacy

ccmux is a zero-telemetry local proxy. This page documents how your data is handled.

## Zero-telemetry stance

ccmux makes no outbound calls other than to `api.anthropic.com`. Specifically:

- No auto-update checks
- No background telemetry or analytics
- No fixture capture unless explicitly enabled (`CCMUX_RECORD=1`)
- No phone-home on startup, shutdown, or error
- The dashboard opened by `ccmux dashboard` runs in your browser on localhost; ccmux does not serve it to external networks

The SPA bundle is checked in CI for zero external URLs. The backend is tested to make zero outbound requests on cold start.

## Logging content modes

The `logging.content` key controls how message content appears in decision logs.

### hashed (default)

Message strings and tool `input` fields are replaced with `sha256(content).slice(0, 12)`.

**Equality linkable:** two identical messages produce the same 12-character hash and are linkable across log entries. With `hashed`, someone with access to your log files can determine that the same content appeared in multiple requests, even though they cannot recover the original text. Use `none` on shared machines.

### full

Everything is logged verbatim. Auth headers (`x-api-key`, `authorization`, `x-ccmux-token`) are still redacted by the sanitizer and appear as `[REDACTED]`.

Use this mode only on personal machines where you want complete request/response logs for debugging.

### none

Messages and tool inputs are dropped entirely. Only routing signals (token counts, tool counts, etc.) and metadata (timestamp, chosen model, matched rule) remain in the decision log.

This is the most private mode. Use it on shared machines or when logging content is not acceptable.

## What is logged

Regardless of content mode, the decision log always records:

- Timestamp
- Chosen model and tier
- Matched rule ID (or "classifier"/"heuristic")
- Extracted signals (token count, tool count, plan mode, etc.)
- Confidence score
- Cost estimate
- `cache_buster` (only on requests the cache-buster detector flagged): the kinds of changing value found in the cached prompt prefix (`date`, `time`, `uuid`, `hex_id`) and a fingerprint of the prefix with those values masked out

### The `cache_buster` field

The detector compares each request's cached prefix (tool definitions, then system prompt) with earlier requests to spot values such as dates or UUIDs that change every time and defeat prompt caching. It reads the request; it never changes what is forwarded.

The field is identical in `hashed`, `full` and `none` modes. It holds only:

- **Value kinds.** Labels such as `date`. The values themselves are never written.
- **A fingerprint.** HMAC-SHA256 of the masked prefix, truncated, keyed with a random secret generated when ccmux starts and never stored. Unlike the plain `sha256` used by `hashed` mode, it cannot be compared across restarts, so two ccmux runs cannot be linked through it, and the prefix cannot be recovered from it.

No prompt text, tool text or raw date, time or id is logged. Detection state lives in memory only, is capped in size, and is lost when ccmux exits. In `full` mode the same finding may also appear inside `extracted_signals`; it carries no more than the top-level field.

## What is never logged

- Full API keys (always redacted)
- Proxy tokens (always redacted)
- Response bodies (only signals extracted from responses)

## Auth passthrough

Your `x-api-key` header passes through to Anthropic unchanged. ccmux reads it only to forward it. ccmux is not an auth broker and does not store, cache, or validate your API key.

## File permissions

Log files and config are written with mode `0700` (directory) / `0600` (files) on POSIX systems. On Windows, standard user-only ACLs apply. These files are readable by the same user account that runs ccmux.

## See also

- [Threat Model](threat-model.md) for security scope and limitations
- [Configuration Reference](config-reference.md) for the `logging` config block
