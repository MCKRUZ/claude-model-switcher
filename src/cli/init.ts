import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from '../config/paths.js';

const VALID_RECIPES = ['frugal', 'balanced', 'opus-forward'] as const;
type RecipeName = (typeof VALID_RECIPES)[number];

const here = dirname(fileURLToPath(import.meta.url));
// Both src/cli/ and dist/cli/ resolve ../../src/policy/recipes/ to the same place.
const RECIPE_DIR = join(here, '..', '..', 'src', 'policy', 'recipes');

export interface InitOptions {
  readonly recipe: string;
  readonly force: boolean;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

function isValidRecipe(name: string): name is RecipeName {
  return (VALID_RECIPES as readonly string[]).includes(name);
}

export function runInit(opts: InitOptions): number {
  if (!isValidRecipe(opts.recipe)) {
    opts.stderr.write(
      `Unknown recipe "${opts.recipe}". Valid recipes: ${VALID_RECIPES.join(', ')}\n`,
    );
    return 2;
  }

  let recipeContent: string;
  try {
    recipeContent = readFileSync(join(RECIPE_DIR, `${opts.recipe}.yaml`), 'utf8');
  } catch {
    opts.stderr.write(`Failed to read recipe "${opts.recipe}" from ${RECIPE_DIR}\n`);
    return 2;
  }
  const paths = resolvePaths();
  const target = paths.configFile;

  if (existsSync(target) && !opts.force) {
    opts.stderr.write(
      `Config already exists at ${target}\nUse --force to overwrite.\n`,
    );
    return 1;
  }

  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, recipeContent, 'utf8');
  opts.stdout.write(`${target}\n`);
  return 0;
}
