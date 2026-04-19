# Threat Model

ccmux is a **local** proxy. This page documents what it protects against and what it does not.

## Scope

ccmux binds to `127.0.0.1` only. It is designed to run on a single-user developer workstation. It is not a network service, not a multi-tenant proxy, and not an auth broker.

## What ccmux protects

### Cost optimization

ccmux routes requests to cheaper models when quality requirements allow. The policy engine and classifier prevent unnecessary Opus usage, reducing API costs.

### Privacy modes

Decision logs can use `hashed` or `none` content modes to avoid storing raw message content on disk. See [Privacy](privacy.md).

### No telemetry

ccmux makes zero outbound requests except to `api.anthropic.com`. No usage data leaves your machine. This is enforced by CI smoke tests.

## What ccmux does NOT protect against

### Compromised local user account

If an attacker has access to your user account, they can read ccmux config, logs, and API keys. ccmux files use mode 0600/0700 but are readable by the owning user.

### Network-level attacks on localhost

ccmux uses plain HTTP on `127.0.0.1`. Any process on the same machine can connect to the proxy port. This is standard for local development proxies.

### API key theft

Your `x-api-key` passes through ccmux to Anthropic unchanged. ccmux does not encrypt, rotate, or scope the key. If your key is compromised, that is outside ccmux's scope.

### Model output quality

ccmux picks a model tier based on signals and rules, but it cannot guarantee the chosen model produces correct output. A request routed to Haiku may produce lower-quality results than Opus would have.

## Hashed-log linkability

With `logging.content: hashed`, message content is replaced with `sha256(content).slice(0, 12)`. This is a deterministic hash:

- Two identical messages produce the same hash
- An attacker with log access can determine that the same content appeared in multiple requests
- An attacker who can guess the content can verify their guess against the hash

This is **equality linkable**. If linkability is unacceptable, use `logging.content: none`.

The 12-character truncated hash is not brute-force resistant for short messages. Do not rely on it as a security mechanism. It is a privacy convenience, not a cryptographic guarantee.

## Recommendations

- Use `logging.content: none` on shared machines
- Keep ccmux config directory permissions at 0700
- Do not expose the proxy port to the network (ccmux refuses to bind `0.0.0.0`, but a reverse proxy could expose it)
- Rotate your Anthropic API key periodically
- Review decision logs for unexpected routing patterns
