# Troubleshooting

## EADDRINUSE on start

**Symptom:** `Error: listen EADDRINUSE :::8787`

**Cause:** Port 8787 is already in use (another ccmux instance, or another service).

**Fix:** ccmux tries sequential ports automatically. If that fails, override with `--port`:

```bash
ccmux start --port 9090
```

Or kill the existing process: check `ccmux status` for the PID.

## Claude CLI hangs after setting up proxy

**Symptom:** `ccmux run -- claude` starts but Claude never connects.

**Cause:** `ANTHROPIC_BASE_URL` not set in the child environment, or set to the wrong value.

**Fix:** Verify with `ccmux status` that the proxy is running and note the port. Then check:

```bash
echo $ANTHROPIC_BASE_URL
# Should be http://127.0.0.1:8787
```

If using `ccmux run`, the env var is set automatically. If starting the proxy separately, set it manually.

## Costs show null in report

**Symptom:** `ccmux report` shows `null` for cost columns.

**Cause:** The upstream response is missing `usage.input_tokens` or `usage.output_tokens` fields. This happens when streaming responses do not include the final usage event.

**Fix:** Check that your classifier model and streaming configuration produce usage data. Non-streaming responses always include usage. For streaming, Anthropic includes usage in the `message_delta` event.

## Config change not picked up

**Symptom:** You edited `config.yaml` but the proxy behavior did not change.

**Cause:** ccmux debounces config file changes by 500ms. If your YAML has a syntax error, the previous valid config stays active.

**Fix:** Check the proxy logs for lines like `config reload failed: invalid YAML`. Fix the syntax error. The next save will trigger a reload.

```bash
# Validate your config
ccmux explain '{"messages":[{"role":"user","content":"test"}]}' --config ~/.config/ccmux/config.yaml
```

## Dashboard shows no data

**Symptom:** `ccmux dashboard` opens but all charts are empty.

**Cause:** Decision log path mismatch, or no requests have been routed yet.

**Fix:** Confirm the decision log directory exists:

```bash
ls ~/.config/ccmux/logs/decisions/
```

If empty, route a request through the proxy first. If the directory does not exist, check that ccmux has write permissions to the config directory.

## HTTP/2 client error

**Symptom:** Client gets a connection error or `ERR_HTTP2_PROTOCOL_ERROR`.

**Cause:** ccmux rejects HTTP/2 prior-knowledge connections. It only supports HTTP/1.1.

**Fix:** Configure your client to use HTTP/1.1. Most HTTP clients default to HTTP/1.1 for `http://` URLs. If your client forces h2, disable it.

## Classifier timeout

**Symptom:** Logs show `classifier timeout` and the heuristic is used instead.

**Cause:** The Haiku classifier call took longer than `classifier.timeoutMs` (default: 800ms).

**Fix:** This is expected behavior. The heuristic provides a fallback result. If it happens frequently, increase the timeout:

```yaml
classifier:
  timeoutMs: 1500
```

## Proxy token rejected

**Symptom:** `403 Forbidden` on all requests.

**Cause:** `security.requireProxyToken` is true but the client is not sending `x-ccmux-token`.

**Fix:** Either set the token header on your client, or disable the requirement:

```yaml
security:
  requireProxyToken: false
```
