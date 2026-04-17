// `ccmux version` handler. Reads package.json once at module load.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageManifest {
  readonly name: string;
  readonly version: string;
}

function loadManifest(): PackageManifest {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/cli/version.ts and dist/cli/version.js both resolve ../../package.json.
  const manifestPath = join(here, '..', '..', 'package.json');
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
  return { name: parsed.name, version: parsed.version };
}

const MANIFEST = loadManifest();

export const NAME = MANIFEST.name;
export const VERSION = MANIFEST.version;

export function runVersion(stdout: NodeJS.WritableStream = process.stdout): number {
  stdout.write(`${NAME} ${VERSION}\n`);
  return 0;
}
