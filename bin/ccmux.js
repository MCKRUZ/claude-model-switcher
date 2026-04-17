#!/usr/bin/env node
// Thin shim that forwards argv to the compiled CLI router.
import('../dist/cli/main.js')
  .then((m) => m.run(process.argv.slice(2)))
  .then((code) => { process.exit(typeof code === 'number' ? code : 0); })
  .catch((err) => { process.stderr.write(`ccmux: ${err?.message ?? err}\n`); process.exit(1); });
