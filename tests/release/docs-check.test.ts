import { describe, it, expect } from 'vitest';
import { checkDocs } from '../../scripts/docs-check.js';

describe('docs-check', () => {
  it('passes on the actual project docs', async () => {
    const result = await checkDocs();
    if (!result.ok) {
      console.error('Doc check errors:', result.errors);
    }
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
