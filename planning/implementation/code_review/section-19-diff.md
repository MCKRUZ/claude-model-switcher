diff --git a/package.json b/package.json
index b2dbf6b..f493280 100644
--- a/package.json
+++ b/package.json
@@ -14,6 +14,7 @@
   "files": [
     "bin",
     "dist",
+    "src/policy/recipes",
     "README.md",
     "LICENSE"
   ],
diff --git a/planning/implementation/deep_implement_config.json b/planning/implementation/deep_implement_config.json
index fd49562..0304a0e 100644
--- a/planning/implementation/deep_implement_config.json
+++ b/planning/implementation/deep_implement_config.json
@@ -98,6 +98,10 @@
     "section-17-dashboard-server": {
       "status": "complete",
       "commit_hash": "84f8adc"
+    },
+    "section-18-dashboard-spa": {
+      "status": "complete",
+      "commit_hash": "b0445b9"
     }
   },
   "pre_commit": {
diff --git a/src/cli/init.ts b/src/cli/init.ts
index 60b0467..e76856a 100644
--- a/src/cli/init.ts
+++ b/src/cli/init.ts
@@ -1,2 +1,47 @@
-// Populated in section-19. Do not import.
-export {};
+import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
+import { dirname, join } from 'node:path';
+import { fileURLToPath } from 'node:url';
+import { resolvePaths } from '../config/paths.js';
+
+const VALID_RECIPES = ['frugal', 'balanced', 'opus-forward'] as const;
+type RecipeName = (typeof VALID_RECIPES)[number];
+
+const here = dirname(fileURLToPath(import.meta.url));
+// Both src/cli/ and dist/cli/ resolve ../../src/policy/recipes/ to the same place.
+const RECIPE_DIR = join(here, '..', '..', 'src', 'policy', 'recipes');
+
+export interface InitOptions {
+  readonly recipe: string;
+  readonly force: boolean;
+  readonly stdout: NodeJS.WritableStream;
+  readonly stderr: NodeJS.WritableStream;
+}
+
+function isValidRecipe(name: string): name is RecipeName {
+  return (VALID_RECIPES as readonly string[]).includes(name);
+}
+
+export function runInit(opts: InitOptions): number {
+  if (!isValidRecipe(opts.recipe)) {
+    opts.stderr.write(
+      `Unknown recipe "${opts.recipe}". Valid recipes: ${VALID_RECIPES.join(', ')}\n`,
+    );
+    return 2;
+  }
+
+  const recipeContent = readFileSync(join(RECIPE_DIR, `${opts.recipe}.yaml`), 'utf8');
+  const paths = resolvePaths();
+  const target = paths.configFile;
+
+  if (existsSync(target) && !opts.force) {
+    opts.stderr.write(
+      `Config already exists at ${target}\nUse --force to overwrite.\n`,
+    );
+    return 1;
+  }
+
+  mkdirSync(dirname(target), { recursive: true });
+  writeFileSync(target, recipeContent, 'utf8');
+  opts.stdout.write(`${target}\n`);
+  return 0;
+}
diff --git a/src/cli/main.ts b/src/cli/main.ts
index 170e7f2..76fb9f2 100644
--- a/src/cli/main.ts
+++ b/src/cli/main.ts
@@ -73,11 +73,34 @@ function buildProgram(
       const { runVersion } = await import('./version.js');
       box.code = runVersion(stdout);
     });
+  registerInit(program, box, stdout, stderr);
   registerReport(program, box, stdout, stderr);
   registerTune(program, box, stdout, stderr);
   return program;
 }
 
+function registerInit(
+  program: Command,
+  box: ActionBox,
+  stdout: NodeJS.WritableStream,
+  stderr: NodeJS.WritableStream,
+): void {
+  program
+    .command('init')
+    .description('Scaffold a starter config.yaml from a recipe (frugal, balanced, opus-forward)')
+    .option('--recipe <name>', 'Recipe to use', 'balanced')
+    .option('--force', 'Overwrite existing config', false)
+    .action(async (cmdOpts: { recipe: string; force: boolean }) => {
+      const { runInit } = await import('./init.js');
+      box.code = runInit({
+        recipe: cmdOpts.recipe,
+        force: cmdOpts.force,
+        stdout,
+        stderr,
+      });
+    });
+}
+
 function registerReport(
   program: Command,
   box: ActionBox,
diff --git a/tests/cli/init.test.ts b/tests/cli/init.test.ts
new file mode 100644
index 0000000..755edbd
--- /dev/null
+++ b/tests/cli/init.test.ts
@@ -0,0 +1,123 @@
+import { describe, it, expect, beforeEach, afterEach } from 'vitest';
+import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import { rmSync } from 'node:fs';
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
+describe('ccmux init', () => {
+  let tmpDir: string;
+  let originalEnv: string | undefined;
+
+  beforeEach(() => {
+    tmpDir = mkdtempSync(join(tmpdir(), 'ccmux-init-'));
+    originalEnv = process.env['CCMUX_HOME'];
+    process.env['CCMUX_HOME'] = tmpDir;
+  });
+
+  afterEach(() => {
+    if (originalEnv === undefined) {
+      delete process.env['CCMUX_HOME'];
+    } else {
+      process.env['CCMUX_HOME'] = originalEnv;
+    }
+    rmSync(tmpDir, { recursive: true, force: true });
+  });
+
+  it('should write balanced recipe by default to the resolved config path', async () => {
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await run(['init'], { stdout: out.stream, stderr: err.stream });
+    expect(code).toBe(0);
+    const configPath = join(tmpDir, 'config.yaml');
+    expect(existsSync(configPath)).toBe(true);
+    const content = readFileSync(configPath, 'utf8');
+    expect(content).toMatch(/Recipe: balanced/);
+    expect(out.read()).toContain(configPath);
+  });
+
+  it('should write the named recipe when --recipe is passed', async () => {
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await run(['init', '--recipe', 'frugal'], { stdout: out.stream, stderr: err.stream });
+    expect(code).toBe(0);
+    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf8');
+    expect(content).toMatch(/Recipe: frugal/);
+  });
+
+  it('should exit non-zero with a helpful message on an unknown recipe name', async () => {
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await run(['init', '--recipe', 'nonexistent'], { stdout: out.stream, stderr: err.stream });
+    expect(code).toBe(2);
+    const stderr = err.read();
+    expect(stderr).toMatch(/frugal/);
+    expect(stderr).toMatch(/balanced/);
+    expect(stderr).toMatch(/opus-forward/);
+  });
+
+  it('should refuse to overwrite an existing config without --force', async () => {
+    writeFileSync(join(tmpDir, 'config.yaml'), 'existing: true\n');
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await run(['init'], { stdout: out.stream, stderr: err.stream });
+    expect(code).toBe(1);
+    const stderr = err.read();
+    expect(stderr).toMatch(/--force/);
+    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf8');
+    expect(content).toBe('existing: true\n');
+  });
+
+  it('should overwrite when --force is passed', async () => {
+    writeFileSync(join(tmpDir, 'config.yaml'), 'existing: true\n');
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await run(['init', '--force'], { stdout: out.stream, stderr: err.stream });
+    expect(code).toBe(0);
+    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf8');
+    expect(content).toMatch(/Recipe: balanced/);
+  });
+
+  it('should create the target directory if missing', async () => {
+    const nested = join(tmpDir, 'sub', 'dir');
+    process.env['CCMUX_HOME'] = nested;
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await run(['init'], { stdout: out.stream, stderr: err.stream });
+    expect(code).toBe(0);
+    expect(existsSync(join(nested, 'config.yaml'))).toBe(true);
+  });
+
+  it('should produce output that the config loader parses without errors', async () => {
+    const out = bufferStream();
+    const err = bufferStream();
+    await run(['init'], { stdout: out.stream, stderr: err.stream });
+    const { loadConfig } = await import('../../src/config/loader.js');
+    const result = await loadConfig(join(tmpDir, 'config.yaml'));
+    expect(result.ok).toBe(true);
+    if (result.ok) {
+      expect(result.value.warnings).toHaveLength(0);
+    }
+  });
+
+  it('should write opus-forward recipe when requested', async () => {
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await run(['init', '--recipe', 'opus-forward'], { stdout: out.stream, stderr: err.stream });
+    expect(code).toBe(0);
+    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf8');
+    expect(content).toMatch(/Recipe: opus-forward/);
+  });
+});
