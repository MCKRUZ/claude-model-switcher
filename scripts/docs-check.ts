// Documentation validation: link checker, YAML lint, required strings, no placeholders.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { CORE_SCHEMA, load as yamlLoad } from 'js-yaml';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

export interface CheckResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

function collectMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectMarkdownFiles(full));
    else if (entry.name.endsWith('.md')) results.push(full);
  }
  return results;
}

function checkRelativeLinks(file: string, content: string): string[] {
  const errors: string[] = [];
  const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g;
  for (const match of content.matchAll(linkPattern)) {
    const target = match[2]!;
    if (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('#')) continue;
    const anchor = target.indexOf('#');
    const path = anchor >= 0 ? target.slice(0, anchor) : target;
    if (!path) continue;
    const resolved = resolve(dirname(file), path);
    if (!existsSync(resolved)) {
      errors.push(`${file}: broken link [${match[1]}](${target}) -> ${resolved}`);
    }
  }
  return errors;
}

function checkYamlFences(file: string, content: string): string[] {
  const errors: string[] = [];
  const fencePattern = /```ya?ml\n([\s\S]*?)```/g;
  let idx = 0;
  for (const match of content.matchAll(fencePattern)) {
    idx++;
    try {
      yamlLoad(match[1]!, { schema: CORE_SCHEMA });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${file}: YAML fence #${idx} invalid: ${msg}`);
    }
  }
  return errors;
}

function checkRequiredStrings(file: string, content: string, required: readonly string[]): string[] {
  const errors: string[] = [];
  for (const str of required) {
    if (!content.includes(str)) {
      errors.push(`${file}: missing required string "${str}"`);
    }
  }
  return errors;
}

function checkNoPlaceholders(file: string, content: string): string[] {
  const errors: string[] = [];
  const forbidden = ['TODO', 'TBD', 'FIXME', '<placeholder>'];
  for (const term of forbidden) {
    if (content.includes(term)) {
      errors.push(`${file}: contains forbidden placeholder "${term}"`);
    }
  }
  return errors;
}

export async function checkDocs(): Promise<CheckResult> {
  const errors: string[] = [];

  const readmePath = join(ROOT, 'README.md');
  const docsDir = join(ROOT, 'docs');
  const privacyPath = join(docsDir, 'privacy.md');

  const allFiles = [readmePath, ...collectMarkdownFiles(docsDir)].filter(f => existsSync(f));

  for (const file of allFiles) {
    const content = readFileSync(file, 'utf-8');
    errors.push(...checkRelativeLinks(file, content));
    errors.push(...checkNoPlaceholders(file, content));
  }

  const configRef = join(docsDir, 'config-reference.md');
  const recipesDoc = join(docsDir, 'recipes.md');
  const ruleDsl = join(docsDir, 'rule-dsl.md');
  for (const file of [configRef, recipesDoc, ruleDsl]) {
    if (existsSync(file)) {
      errors.push(...checkYamlFences(file, readFileSync(file, 'utf-8')));
    }
  }

  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf-8');
    errors.push(...checkRequiredStrings(readmePath, readme, ['zero-telemetry', 'api.anthropic.com']));
  }

  if (existsSync(privacyPath)) {
    const privacy = readFileSync(privacyPath, 'utf-8');
    errors.push(...checkRequiredStrings(privacyPath, privacy, ['zero-telemetry', 'api.anthropic.com']));
  }

  return { ok: errors.length === 0, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void checkDocs().then(result => {
    if (!result.ok) {
      console.error('Documentation check failed:');
      for (const err of result.errors) console.error(`  ${err}`);
      process.exit(1);
    }
    console.log('Documentation check passed.');
  });
}
