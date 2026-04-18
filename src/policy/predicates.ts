// Leaf predicate matcher. Null/undefined signals never match.

import type { Leaf, LeafOp } from './dsl.js';

export function matchLeaf(leaf: Leaf, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof leaf === 'boolean') return value === leaf;
  return matchLeafOp(leaf, value);
}

function matchLeafOp(op: LeafOp, value: unknown): boolean {
  if ('lt' in op) return typeof value === 'number' && value < op.lt;
  if ('lte' in op) return typeof value === 'number' && value <= op.lte;
  if ('gt' in op) return typeof value === 'number' && value > op.gt;
  if ('gte' in op) return typeof value === 'number' && value >= op.gte;
  if ('eq' in op) return value === op.eq;
  if ('ne' in op) return value !== op.ne;
  if ('in' in op) return op.in.some((x) => value === x);
  if ('matches' in op) return typeof value === 'string' && op.matches.test(value);
  return false;
}
