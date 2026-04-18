#!/usr/bin/env node
// Test fixture: records select env vars to a file, then exits (or loops on
// signal) based on env flags set by the test.
//
// Env contract:
//   CCMUX_TEST_OUT   — absolute path; JSON snapshot of selected env vars is written here
//   CCMUX_TEST_MODE  — "exit" (default), "loop" (block until signal), or "sleep:<ms>"
//   CCMUX_TEST_CODE  — integer; exit code to use for "exit" mode (default 0)

import { writeFileSync } from 'node:fs';

const OUT_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'NO_PROXY',
  'no_proxy',
  'NOPROXY',
  'CCMUX_PROXY_TOKEN',
];

const outPath = process.env.CCMUX_TEST_OUT;
if (outPath) {
  const snapshot = {};
  for (const key of OUT_KEYS) snapshot[key] = process.env[key] ?? '';
  writeFileSync(outPath, JSON.stringify(snapshot));
}

const mode = process.env.CCMUX_TEST_MODE ?? 'exit';

if (mode === 'loop') {
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  setInterval(() => {}, 3600_000);
} else if (mode.startsWith('sleep:')) {
  const ms = Number(mode.slice('sleep:'.length));
  setTimeout(() => process.exit(0), Number.isFinite(ms) ? ms : 100);
} else {
  const code = Number(process.env.CCMUX_TEST_CODE ?? '0');
  process.exit(Number.isFinite(code) ? code : 0);
}
