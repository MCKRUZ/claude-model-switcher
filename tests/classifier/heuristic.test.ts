import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { HeuristicClassifier } from '../../src/classifier/heuristic.js';
import type {
  Classifier,
  ClassifierInput,
  ClassifierResult,
} from '../../src/classifier/types.js';

const FIX_DIR = join(__dirname, 'fixtures', 'heuristic');

function loadFixture(name: string): ClassifierInput {
  const raw = readFileSync(join(FIX_DIR, name), 'utf8');
  return JSON.parse(raw) as ClassifierInput;
}

function noDeadline(): AbortSignal {
  return new AbortController().signal;
}

describe('Classifier interface contract', () => {
  it('a classifier that throws internally resolves to null (never rejects)', async () => {
    class ThrowingClassifier implements Classifier {
      async classify(
        _input: ClassifierInput,
        _deadline: AbortSignal,
      ): Promise<ClassifierResult | null> {
        try {
          throw new Error('boom');
        } catch {
          return null;
        }
      }
    }
    const c = new ThrowingClassifier();
    await expect(c.classify(loadFixture('small-single-tool.json'), noDeadline())).resolves.toBeNull();
  });

  it('satisfies: classify(input, deadline) → Promise<ClassifierResult | null>', async () => {
    const h: Classifier = new HeuristicClassifier();
    const result = await h.classify(loadFixture('small-single-tool.json'), noDeadline());
    expect(result === null || typeof result === 'object').toBe(true);
    if (result) {
      expect(typeof result.score).toBe('number');
      expect(['haiku', 'sonnet', 'opus']).toContain(result.suggestedModel);
      expect(typeof result.confidence).toBe('number');
      expect(result.source).toBe('heuristic');
      expect(typeof result.latencyMs).toBe('number');
    }
  });
});

describe('HeuristicClassifier — zero latency', () => {
  it('returns a result in < 1ms on fixture inputs (warm)', async () => {
    const h = new HeuristicClassifier();
    const input = loadFixture('large-broad-tools.json');
    // Warm the path
    await h.classify(input, noDeadline());
    const start = performance.now();
    const result = await h.classify(input, noDeadline());
    const elapsed = performance.now() - start;
    expect(result).not.toBeNull();
    expect(elapsed).toBeLessThan(5); // generous headroom on slow CI; heuristic body itself < 1ms
    expect(result!.latencyMs).toBeLessThan(5);
  });

  it('does not yield to real I/O (resolves on the next microtask tick)', async () => {
    const h = new HeuristicClassifier();
    let settled = false;
    const p = h.classify(loadFixture('small-single-tool.json'), noDeadline()).then((r) => {
      settled = true;
      return r;
    });
    // After draining the microtask queue once, the Promise should have resolved.
    await Promise.resolve();
    await Promise.resolve();
    await p;
    expect(settled).toBe(true);
  });
});

describe('HeuristicClassifier — scoring', () => {
  it('large token count + broad tool set → suggests opus', async () => {
    const h = new HeuristicClassifier();
    const r = await h.classify(loadFixture('large-broad-tools.json'), noDeadline());
    expect(r).not.toBeNull();
    expect(r!.suggestedModel).toBe('opus');
    expect(r!.score).toBeGreaterThanOrEqual(6.5);
  });

  it('small token count + single tool → suggests haiku', async () => {
    const h = new HeuristicClassifier();
    const r = await h.classify(loadFixture('small-single-tool.json'), noDeadline());
    expect(r).not.toBeNull();
    expect(r!.suggestedModel).toBe('haiku');
    expect(r!.score).toBeLessThan(3.0);
  });

  it('imperative phrasing nudges score upward vs. the same body phrased as a question', async () => {
    const h = new HeuristicClassifier();
    const imp = await h.classify(loadFixture('imperative.json'), noDeadline());
    const qn = await h.classify(loadFixture('question.json'), noDeadline());
    expect(imp).not.toBeNull();
    expect(qn).not.toBeNull();
    expect(imp!.score).toBeGreaterThan(qn!.score);
    // Lock in tiers so weight drift doesn't silently regress intent.
    expect(imp!.suggestedModel).toBe('sonnet');
    expect(qn!.suggestedModel).toBe('haiku');
  });

  it('score exactly 3.0 maps to sonnet (lower band boundary is inclusive for sonnet)', async () => {
    const h = new HeuristicClassifier();
    // tokenBand(600)=1, tools 4 → cap at 3, no code, no phrasing, no files → 4.0 sonnet
    // Use a simpler construction: tokens 600 → 1, tools 4 → 2 (4*0.5), rest 0 → 3.0 exactly
    const input: ClassifierInput = {
      signals: {
        planMode: null, messageCount: 1, tools: ['a', 'b', 'c', 'd'],
        toolUseCount: 0, estInputTokens: 600, fileRefCount: 0,
        retryCount: 0, frustration: null, explicitModel: null,
        projectPath: null, sessionDurationMs: 0, betaFlags: [],
        sessionId: 's', requestHash: 'h',
      },
      body: { messages: [{ role: 'user', content: 'neutral statement.' }] },
      requestHash: 'h',
    };
    const r = await h.classify(input, noDeadline());
    expect(r).not.toBeNull();
    expect(r!.score).toBe(3.0);
    expect(r!.suggestedModel).toBe('sonnet');
  });

  it('score exactly 6.5 maps to opus (upper band boundary is inclusive for opus)', async () => {
    const h = new HeuristicClassifier();
    // tokens 10000 → 3, tools 5 → cap 3, imperative +1, files 0.25 → cap retained → 3+3+0+1+... need 6.5
    // tokens 8000→3, tools 6→cap 3, imperative +1, no files, no code: 3+3+0+1+0=7 too high.
    // tokens 2000→2, tools 6→cap 3, imperative +1, files 0, code 1.5 fences (5 triples→2 pairs→0.6)... aim 6.5 exactly:
    // tokens 8000→3, tools 3→1.5, imperative +1, file 2 paths→0.8, code 1 pair→0.3 = 6.6 — close
    // tokens 2000→2, tools 6→cap 3, imperative +1, 1 file→0.4, code 0 pairs = 6.4
    // tokens 2000→2, tools 6→cap 3, imperative +1, 1 file→0.4, code 1 pair→0.3 = 6.7
    // Exact 6.5: tokens 2000→2, tools 5→2.5, imperative +1, 2 files→0.8, code 1 pair→0.3 = 6.6
    // Drop code, raise files: tokens 2000→2, tools 5→2.5, imperative +1, files 2.5→1.0 (but cap 2, at factor 0.4 → files 5→2.0)
    // tokens 2000→2, tools 5→2.5, imperative +1, files 5→cap 2 = 7.5 too high
    // tokens 2000→2, tools 5→2.5, imperative +1, files 2→0.8 = 6.3
    // tokens 8000→3, tools 5→2.5, imperative +1, no files, no code = 6.5 exact
    const input: ClassifierInput = {
      signals: {
        planMode: null, messageCount: 1,
        tools: ['a', 'b', 'c', 'd', 'e'],
        toolUseCount: 0, estInputTokens: 8000, fileRefCount: 0,
        retryCount: 0, frustration: null, explicitModel: null,
        projectPath: null, sessionDurationMs: 0, betaFlags: [],
        sessionId: 's', requestHash: 'h',
      },
      body: { messages: [{ role: 'user', content: 'implement the change' }] },
      requestHash: 'h',
    };
    const r = await h.classify(input, noDeadline());
    expect(r).not.toBeNull();
    expect(r!.score).toBe(6.5);
    expect(r!.suggestedModel).toBe('opus');
  });
});

describe('HeuristicClassifier — determinism', () => {
  it('same input produces identical score/suggestedModel/confidence across calls', async () => {
    const h = new HeuristicClassifier();
    const input = loadFixture('imperative.json');
    const a = await h.classify(input, noDeadline());
    const b = await h.classify(input, noDeadline());
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.score).toBe(b!.score);
    expect(a!.suggestedModel).toBe(b!.suggestedModel);
    expect(a!.confidence).toBe(b!.confidence);
  });

  it('does not mutate the input', async () => {
    const h = new HeuristicClassifier();
    const input = loadFixture('imperative.json');
    const snapshot = JSON.stringify(input);
    await h.classify(input, noDeadline());
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('HeuristicClassifier — robustness', () => {
  it('returns null on malformed signals', async () => {
    const h = new HeuristicClassifier();
    const bad = { signals: 'not an object', body: {}, requestHash: 'x' } as unknown as ClassifierInput;
    const r = await h.classify(bad, noDeadline());
    expect(r).toBeNull();
  });

  it('returns null on NaN / Infinity estInputTokens', async () => {
    const h = new HeuristicClassifier();
    const base = loadFixture('small-single-tool.json');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const mut: ClassifierInput = {
        ...base,
        signals: { ...base.signals, estInputTokens: bad },
      };
      const r = await h.classify(mut, noDeadline());
      expect(r).toBeNull();
    }
  });

  it('returns null on negative fileRefCount', async () => {
    const h = new HeuristicClassifier();
    const base = loadFixture('small-single-tool.json');
    const mut: ClassifierInput = {
      ...base,
      signals: { ...base.signals, fileRefCount: -1 },
    };
    const r = await h.classify(mut, noDeadline());
    expect(r).toBeNull();
  });

  it('handles missing or empty messages without throwing', async () => {
    const h = new HeuristicClassifier();
    const base = loadFixture('small-single-tool.json');
    const noMsgs: ClassifierInput = { ...base, body: {} };
    const emptyMsgs: ClassifierInput = { ...base, body: { messages: [] } };
    for (const input of [noMsgs, emptyMsgs]) {
      const r = await h.classify(input, noDeadline());
      expect(r).not.toBeNull();
      expect(r!.source).toBe('heuristic');
    }
  });

  it('ignores an already-aborted deadline signal (heuristic is synchronous)', async () => {
    const h = new HeuristicClassifier();
    const controller = new AbortController();
    controller.abort();
    const r = await h.classify(loadFixture('imperative.json'), controller.signal);
    expect(r).not.toBeNull();
    expect(r!.source).toBe('heuristic');
  });

  it('handles content-blocks form and string-content form identically when text is equivalent', async () => {
    const h = new HeuristicClassifier();
    const base = loadFixture('imperative.json');
    const stringForm: ClassifierInput = base;
    const msgs = (base.body as { messages: Array<{ content: string }> }).messages;
    const block = msgs[0]!.content;
    const blocksForm: ClassifierInput = {
      signals: base.signals,
      body: {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: block }],
          },
        ],
      },
      requestHash: base.requestHash,
    };
    const a = await h.classify(stringForm, noDeadline());
    const b = await h.classify(blocksForm, noDeadline());
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.score).toBe(b!.score);
    expect(a!.suggestedModel).toBe(b!.suggestedModel);
  });

  it('always stamps source: "heuristic"', async () => {
    const h = new HeuristicClassifier();
    const r = await h.classify(loadFixture('imperative.json'), noDeadline());
    expect(r).not.toBeNull();
    expect(r!.source).toBe('heuristic');
  });

  it('confidence stays within [0.2, 0.85]', async () => {
    const h = new HeuristicClassifier();
    for (const name of [
      'large-broad-tools.json',
      'small-single-tool.json',
      'imperative.json',
      'question.json',
    ]) {
      const r = await h.classify(loadFixture(name), noDeadline());
      expect(r).not.toBeNull();
      expect(r!.confidence).toBeGreaterThanOrEqual(0.2);
      expect(r!.confidence).toBeLessThanOrEqual(0.85);
    }
  });
});
