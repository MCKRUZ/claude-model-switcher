diff --git a/planning/implementation/deep_implement_config.json b/planning/implementation/deep_implement_config.json
index 0304a0e..6d5ee06 100644
--- a/planning/implementation/deep_implement_config.json
+++ b/planning/implementation/deep_implement_config.json
@@ -102,6 +102,10 @@
     "section-18-dashboard-spa": {
       "status": "complete",
       "commit_hash": "b0445b9"
+    },
+    "section-19-init-and-recipes": {
+      "status": "complete",
+      "commit_hash": "2134f13"
     }
   },
   "pre_commit": {
diff --git a/src/cli/explain.ts b/src/cli/explain.ts
index 2e9a495..5fd4e12 100644
--- a/src/cli/explain.ts
+++ b/src/cli/explain.ts
@@ -1,2 +1,169 @@
-// Populated in section-20. Do not import.
-export {};
+import { readFileSync } from 'node:fs';
+import { resolve } from 'node:path';
+import pino from 'pino';
+import { loadConfig } from '../config/loader.js';
+import { resolvePaths } from '../config/paths.js';
+import { loadRules } from '../policy/load.js';
+import { evaluate } from '../policy/evaluate.js';
+import { extractSignals } from '../signals/extract.js';
+import { HeuristicClassifier } from '../classifier/heuristic.js';
+import type { Signals, SessionContext } from '../signals/types.js';
+import type { PolicyResult } from '../policy/dsl.js';
+import type { ClassifierResult } from '../classifier/types.js';
+
+export interface ExplainOptions {
+  readonly requestPath: string;
+  readonly configPath?: string;
+  readonly classifier: boolean;
+  readonly stdout: NodeJS.WritableStream;
+  readonly stderr: NodeJS.WritableStream;
+}
+
+function stubSession(): SessionContext {
+  return { createdAt: Date.now(), retrySeen: () => 0 };
+}
+
+function renderChoice(result: PolicyResult): string {
+  if (result.kind === 'abstain') return 'abstain';
+  const r = result.result;
+  if ('choice' in r) {
+    return typeof r.choice === 'string' ? r.choice : r.choice.modelId;
+  }
+  if ('escalate' in r) return `escalate(${r.escalate})`;
+  return 'unknown';
+}
+
+function renderSignalTable(s: Signals): string {
+  const pad = 26;
+  const lines: [string, string][] = [
+    ['plan_mode', String(s.planMode)],
+    ['message_count', String(s.messageCount)],
+    ['tool_count', String(s.toolUseCount)],
+    ['tools', s.tools.length > 0 ? `[${[...s.tools].join(', ')}]` : '[]'],
+    ['token_estimate', String(s.estInputTokens)],
+    ['file_ref_count', String(s.fileRefCount)],
+    ['retry_count', String(s.retryCount)],
+    ['frustration', String(s.frustration)],
+    ['explicit_model', String(s.explicitModel)],
+    ['project_path', String(s.projectPath)],
+    ['session_duration_ms', String(s.sessionDurationMs)],
+    ['beta_flags', s.betaFlags.length > 0 ? `[${[...s.betaFlags].join(', ')}]` : '[]'],
+  ];
+  return lines.map(([k, v]) => `${k.padEnd(pad)}${v}`).join('\n');
+}
+
+function renderPolicy(policy: PolicyResult, ruleCount: number): string {
+  const lines: string[] = [];
+  lines.push(`Evaluated rules: ${ruleCount}`);
+  if (policy.kind === 'matched') {
+    lines.push(`Winning rule:    id="${policy.ruleId}"  ->  ${renderChoice(policy)}`);
+  } else {
+    lines.push('Winning rule:    abstain');
+  }
+  return lines.join('\n');
+}
+
+function renderClassifier(
+  policy: PolicyResult,
+  useClassifier: boolean,
+  result: ClassifierResult | null,
+): string {
+  if (!useClassifier) return '(not requested)';
+  if (policy.kind === 'matched') return '(not invoked — policy matched)';
+  if (!result) return 'classifier not available';
+  return `${result.suggestedModel} (score=${result.score.toFixed(1)}, confidence=${result.confidence.toFixed(2)}, source=${result.source})`;
+}
+
+function renderFinal(
+  policy: PolicyResult,
+  useClassifier: boolean,
+  classifierResult: ClassifierResult | null,
+): string {
+  if (policy.kind === 'matched') {
+    return `${renderChoice(policy)} via rule "${policy.ruleId}"`;
+  }
+  if (useClassifier && classifierResult) {
+    return `${classifierResult.suggestedModel} via classifier (heuristic)`;
+  }
+  return 'abstain (no classifier requested)';
+}
+
+export async function runExplain(opts: ExplainOptions): Promise<number> {
+  const absPath = resolve(opts.requestPath);
+  const configFile = opts.configPath ?? resolvePaths().configFile;
+
+  const configResult = await loadConfig(configFile);
+  if (!configResult.ok) {
+    for (const e of configResult.error) {
+      opts.stderr.write(`config error [${e.path}]: ${e.message}\n`);
+    }
+    return 1;
+  }
+  const { config } = configResult.value;
+
+  let rawJson: string;
+  try {
+    rawJson = readFileSync(absPath, 'utf8');
+  } catch {
+    opts.stderr.write(`Cannot read request file: ${absPath}\n`);
+    return 1;
+  }
+
+  let body: unknown;
+  try {
+    body = JSON.parse(rawJson);
+  } catch {
+    opts.stderr.write(`Invalid JSON in ${absPath}\n`);
+    return 1;
+  }
+
+  const logger = pino({ level: 'silent' });
+  const signals = extractSignals(body, undefined, stubSession(), logger);
+
+  const rawRules = config.rules.map((r) => {
+    const then = r.allowDowngrade !== undefined ? { ...r.then, allowDowngrade: r.allowDowngrade } : r.then;
+    return { id: r.id, when: r.when, then };
+  });
+  const rulesResult = loadRules(rawRules, { modelTiers: config.modelTiers });
+  if (!rulesResult.ok) {
+    for (const e of rulesResult.error) {
+      opts.stderr.write(`rule error [${e.path}]: ${e.message}\n`);
+    }
+    return 1;
+  }
+  const rules = rulesResult.value;
+  const policy = evaluate(rules, signals);
+
+  let classifierResult: ClassifierResult | null = null;
+  if (opts.classifier && policy.kind === 'abstain') {
+    const heuristic = new HeuristicClassifier();
+    classifierResult = await heuristic.classify(
+      { signals, body, requestHash: signals.requestHash },
+      AbortSignal.timeout(5000),
+    );
+  }
+
+  const out = [
+    `Request:          ${absPath}`,
+    `Config:           ${configFile}`,
+    `Mode:             ${config.mode}`,
+    '',
+    'Signals',
+    '-------',
+    renderSignalTable(signals),
+    '',
+    'Policy',
+    '------',
+    renderPolicy(policy, rules.length),
+    '',
+    'Classifier',
+    '----------',
+    renderClassifier(policy, opts.classifier, classifierResult),
+    '',
+    `Final decision:  ${renderFinal(policy, opts.classifier, classifierResult)}`,
+    '',
+  ].join('\n');
+
+  opts.stdout.write(out);
+  return 0;
+}
diff --git a/src/cli/main.ts b/src/cli/main.ts
index 76fb9f2..756f77f 100644
--- a/src/cli/main.ts
+++ b/src/cli/main.ts
@@ -74,6 +74,7 @@ function buildProgram(
       box.code = runVersion(stdout);
     });
   registerInit(program, box, stdout, stderr);
+  registerExplain(program, box, stdout, stderr);
   registerReport(program, box, stdout, stderr);
   registerTune(program, box, stdout, stderr);
   return program;
@@ -101,6 +102,30 @@ function registerInit(
     });
 }
 
+function registerExplain(
+  program: Command,
+  box: ActionBox,
+  stdout: NodeJS.WritableStream,
+  stderr: NodeJS.WritableStream,
+): void {
+  program
+    .command('explain')
+    .description('Dry-run a request through the routing pipeline and print a diagnostic report')
+    .argument('<request>', 'Path to a JSON file containing an Anthropic Messages API request body')
+    .option('--config <path>', 'Override config file path')
+    .option('--classifier', 'Run heuristic classifier if policy abstains', false)
+    .action(async (requestPath: string, cmdOpts: { config?: string; classifier: boolean }) => {
+      const { runExplain } = await import('./explain.js');
+      box.code = await runExplain({
+        requestPath,
+        configPath: cmdOpts.config,
+        classifier: cmdOpts.classifier,
+        stdout,
+        stderr,
+      });
+    });
+}
+
 function registerReport(
   program: Command,
   box: ActionBox,
diff --git a/tests/cli/explain.test.ts b/tests/cli/explain.test.ts
new file mode 100644
index 0000000..76a7f6a
--- /dev/null
+++ b/tests/cli/explain.test.ts
@@ -0,0 +1,178 @@
+import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
+import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import { Writable } from 'node:stream';
+import { run } from '../../src/cli/main.js';
+
+function bufferStream(): { stream: Writable; read: () => string } {
+  const chunks: Buffer[] = [];
+  const stream = new Writable({
+    write(chunk: Buffer | string, _enc, cb) {
+      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
+      cb();
+    },
+  });
+  return { stream, read: () => Buffer.concat(chunks).toString('utf8') };
+}
+
+const FIXTURES = join(
+  import.meta.dirname ?? '',
+  '..',
+  'fixtures',
+  'explain',
+);
+
+function configWithRule(tmpDir: string): string {
+  const configPath = join(tmpDir, 'config.yaml');
+  writeFileSync(configPath, [
+    'port: 7879',
+    'mode: live',
+    'rules:',
+    '  - id: tools-to-opus',
+    '    when:',
+    '      toolUseCount: { gte: 2 }',
+    '    then: { choice: opus }',
+    '  - id: tiny-to-haiku',
+    '    when:',
+    '      all:',
+    '        - { messageCount: { lt: 3 } }',
+    '        - { toolUseCount: { eq: 0 } }',
+    '        - { estInputTokens: { lt: 500 } }',
+    '    then: { choice: haiku }',
+  ].join('\n'));
+  return configPath;
+}
+
+function emptyRulesConfig(tmpDir: string): string {
+  const configPath = join(tmpDir, 'no-rules.yaml');
+  writeFileSync(configPath, 'port: 7879\nmode: live\nrules: []\n');
+  return configPath;
+}
+
+describe('ccmux explain', () => {
+  let tmpDir: string;
+
+  beforeEach(() => {
+    tmpDir = mkdtempSync(join(tmpdir(), 'ccmux-explain-'));
+  });
+
+  afterEach(() => {
+    rmSync(tmpDir, { recursive: true, force: true });
+  });
+
+  it('should print the winning rule id for a matching fixture', async () => {
+    const configPath = configWithRule(tmpDir);
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await run(
+      ['explain', join(FIXTURES, 'valid-with-tools.json'), '--config', configPath],
+      { stdout: out.stream, stderr: err.stream },
+    );
+    expect(code).toBe(0);
+    const output = out.read();
+    expect(output).toContain('tools-to-opus');
+    expect(output).toContain('opus');
+  });
+
+  it('should print abstain when no rule matches', async () => {
+    const configPath = emptyRulesConfig(tmpDir);
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await run(
+      ['explain', join(FIXTURES, 'valid-minimal.json'), '--config', configPath],
+      { stdout: out.stream, stderr: err.stream },
+    );
+    expect(code).toBe(0);
+    const output = out.read();
+    expect(output).toContain('abstain');
+  });
+
+  it('should render extracted signals in a stable table', async () => {
+    const configPath = configWithRule(tmpDir);
+    const out = bufferStream();
+    const err = bufferStream();
+    await run(
+      ['explain', join(FIXTURES, 'valid-minimal.json'), '--config', configPath],
+      { stdout: out.stream, stderr: err.stream },
+    );
+    const output = out.read();
+    expect(output).toContain('plan_mode');
+    expect(output).toContain('message_count');
+    expect(output).toContain('tool_count');
+    expect(output).toContain('token_estimate');
+    expect(output).toContain('Signals');
+    expect(output).toContain('Policy');
+
+    const out2 = bufferStream();
+    const err2 = bufferStream();
+    await run(
+      ['explain', join(FIXTURES, 'valid-minimal.json'), '--config', configPath],
+      { stdout: out2.stream, stderr: err2.stream },
+    );
+    const normalize = (s: string) => s.replace(/session_duration_ms\s+\d+/, 'session_duration_ms 0');
+    expect(normalize(out2.read())).toBe(normalize(output));
+  });
+
+  it('should exit non-zero when the request JSON is malformed', async () => {
+    const configPath = configWithRule(tmpDir);
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await run(
+      ['explain', join(FIXTURES, 'malformed.json'), '--config', configPath],
+      { stdout: out.stream, stderr: err.stream },
+    );
+    expect(code).toBe(1);
+    expect(err.read()).toContain('Invalid JSON');
+  });
+
+  it('should exit non-zero when the request file does not exist', async () => {
+    const configPath = configWithRule(tmpDir);
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await run(
+      ['explain', join(tmpDir, 'nonexistent.json'), '--config', configPath],
+      { stdout: out.stream, stderr: err.stream },
+    );
+    expect(code).toBe(1);
+    expect(err.read()).toContain('Cannot read');
+  });
+
+  it('should never perform network I/O', async () => {
+    const fetchSpy = vi.spyOn(globalThis, 'fetch');
+    const configPath = configWithRule(tmpDir);
+    const out = bufferStream();
+    const err = bufferStream();
+    await run(
+      ['explain', join(FIXTURES, 'valid-with-tools.json'), '--config', configPath],
+      { stdout: out.stream, stderr: err.stream },
+    );
+    expect(fetchSpy).not.toHaveBeenCalled();
+    fetchSpy.mockRestore();
+  });
+
+  it('should honor --classifier by showing heuristic result on abstain', async () => {
+    const configPath = emptyRulesConfig(tmpDir);
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await run(
+      ['explain', join(FIXTURES, 'valid-with-tools.json'), '--config', configPath, '--classifier'],
+      { stdout: out.stream, stderr: err.stream },
+    );
+    expect(code).toBe(0);
+    const output = out.read();
+    expect(output).toContain('heuristic');
+    expect(output).toContain('via classifier');
+  });
+
+  it('should show "(not requested)" for classifier when flag is omitted', async () => {
+    const configPath = configWithRule(tmpDir);
+    const out = bufferStream();
+    const err = bufferStream();
+    await run(
+      ['explain', join(FIXTURES, 'valid-minimal.json'), '--config', configPath],
+      { stdout: out.stream, stderr: err.stream },
+    );
+    expect(out.read()).toContain('(not requested)');
+  });
+});
diff --git a/tests/fixtures/explain/malformed.json b/tests/fixtures/explain/malformed.json
new file mode 100644
index 0000000..6d71c26
--- /dev/null
+++ b/tests/fixtures/explain/malformed.json
@@ -0,0 +1 @@
+{ "model": "claude-sonnet-4-5-20250514", "messages": [,] }
diff --git a/tests/fixtures/explain/valid-minimal.json b/tests/fixtures/explain/valid-minimal.json
new file mode 100644
index 0000000..e9429d6
--- /dev/null
+++ b/tests/fixtures/explain/valid-minimal.json
@@ -0,0 +1,10 @@
+{
+  "model": "claude-sonnet-4-5-20250514",
+  "max_tokens": 1024,
+  "messages": [
+    {
+      "role": "user",
+      "content": "What is 2 + 2?"
+    }
+  ]
+}
diff --git a/tests/fixtures/explain/valid-with-tools.json b/tests/fixtures/explain/valid-with-tools.json
new file mode 100644
index 0000000..18bc330
--- /dev/null
+++ b/tests/fixtures/explain/valid-with-tools.json
@@ -0,0 +1,45 @@
+{
+  "model": "claude-sonnet-4-5-20250514",
+  "max_tokens": 4096,
+  "system": "You are a coding assistant.",
+  "tools": [
+    { "name": "Read", "description": "Read a file", "input_schema": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } },
+    { "name": "Grep", "description": "Search files", "input_schema": { "type": "object", "properties": { "pattern": { "type": "string" } }, "required": ["pattern"] } }
+  ],
+  "messages": [
+    {
+      "role": "user",
+      "content": "Refactor the auth module to use dependency injection"
+    },
+    {
+      "role": "assistant",
+      "content": [
+        { "type": "text", "text": "I'll read the current auth module first." },
+        { "type": "tool_use", "id": "tu_1", "name": "Read", "input": { "path": "/home/user/proj/src/auth.ts" } }
+      ]
+    },
+    {
+      "role": "user",
+      "content": [
+        { "type": "tool_result", "tool_use_id": "tu_1", "content": "export class AuthService { ... }" }
+      ]
+    },
+    {
+      "role": "assistant",
+      "content": [
+        { "type": "text", "text": "Now let me search for usages." },
+        { "type": "tool_use", "id": "tu_2", "name": "Grep", "input": { "pattern": "AuthService" } }
+      ]
+    },
+    {
+      "role": "user",
+      "content": [
+        { "type": "tool_result", "tool_use_id": "tu_2", "content": "src/app.ts:5: new AuthService()" }
+      ]
+    },
+    {
+      "role": "user",
+      "content": "Please continue with the refactoring"
+    }
+  ]
+}
