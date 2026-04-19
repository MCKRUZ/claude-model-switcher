// Indirection layer over node:fs so tests can vi.spyOn() the helpers.
// vi.spyOn cannot redefine ESM module exports directly, but it can mutate
// our own object's properties.

import {
  copyFileSync,
  fsyncSync,
  openSync,
  closeSync,
  renameSync,
  statSync,
  truncateSync,
} from 'node:fs';

export const fsHelpers = {
  copyFileSync,
  fsyncSync,
  openSync,
  closeSync,
  renameSync,
  statSync,
  truncateSync,
};
