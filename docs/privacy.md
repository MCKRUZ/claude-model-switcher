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
