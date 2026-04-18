// 128-bit random proxy token generator (defense-in-depth per plan §6.8).

import { randomBytes } from 'node:crypto';

export function generateProxyToken(): string {
  return randomBytes(16).toString('hex');
}
