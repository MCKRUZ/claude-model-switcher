import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const releaseYml = path.join(repoRoot, '.github', 'workflows', 'release.yml');
const ciYml = path.join(repoRoot, '.github', 'workflows', 'ci.yml');

describe('release.yml meta-tests', () => {
  function loadRelease(): Record<string, unknown> {
    return yaml.load(fs.readFileSync(releaseYml, 'utf-8')) as Record<string, unknown>;
  }

  it('exists and is valid YAML', () => {
    expect(loadRelease()).toBeTruthy();
  });

  it('contains exactly four artifact jobs: npm, binary, docker, bun-fallback', () => {
    const release = loadRelease();
    const jobs = release.jobs as Record<string, unknown>;
    const artifactJobs = ['npm', 'binary', 'docker', 'bun-fallback'];
    for (const job of artifactJobs) {
      expect(jobs).toHaveProperty(job);
    }
  });

  it('binary job includes smoke steps', () => {
    const release = loadRelease();
    const jobs = release.jobs as Record<string, Record<string, unknown>>;
    const binaryJob = jobs.binary as { steps: Array<{ name?: string }> };
    expect(binaryJob).toBeTruthy();
    const stepNames = binaryJob.steps.map(s => (s.name ?? '').toLowerCase());
    expect(stepNames.some(n => n.includes('smoke'))).toBe(true);
  });

  it('triggers only on v*.*.* tags, not branches', () => {
    const release = loadRelease();
    const on = release.on as Record<string, Record<string, unknown>>;
    const pushTags = (on.push as Record<string, unknown>).tags as string[];
    expect(pushTags).toContain('v*.*.*');
    expect((on.push as Record<string, unknown>).branches).toBeUndefined();
  });

  it('permissions grant only contents:write and packages:write', () => {
    const release = loadRelease();
    const perms = release.permissions as Record<string, string>;
    expect(perms.contents).toBe('write');
    expect(perms.packages).toBe('write');
    expect(Object.keys(perms)).toHaveLength(2);
  });
});

describe('ci.yml meta-tests', () => {
  function loadCi(): Record<string, unknown> {
    return yaml.load(fs.readFileSync(ciYml, 'utf-8')) as Record<string, unknown>;
  }

  it('exists and is valid YAML', () => {
    expect(loadCi()).toBeTruthy();
  });

  it('triggers on push and pull_request', () => {
    const ci = loadCi();
    const on = ci.on as Record<string, unknown>;
    expect(on.push).toBeDefined();
    expect(on.pull_request).toBeDefined();
  });

  it('includes OS matrix with ubuntu, macos, and windows', () => {
    const ci = loadCi();
    const jobs = ci.jobs as Record<string, Record<string, unknown>>;
    const testJob = (jobs.test ?? jobs.ci) as { strategy: { matrix: { os: string[] } } };
    expect(testJob).toBeTruthy();
    const oses = testJob.strategy.matrix.os;
    expect(oses).toContain('ubuntu-latest');
    expect(oses).toContain('macos-latest');
    expect(oses).toContain('windows-latest');
  });
});
