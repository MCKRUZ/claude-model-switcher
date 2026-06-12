import { describe, it, expect } from 'vitest';
import { makeRaceClassifier } from '../../src/classifier/index.js';
import { createClassifierCache } from '../../src/classifier/cache.js';
import type { Classifier, ClassifierInput, ClassifierResult } from '../../src/classifier/types.js';

const INPUT: ClassifierInput = { signals: {} as never, body: {}, requestHash: 'rh1' };

function res(over: Partial<ClassifierResult>): ClassifierResult {
  return { score: 5, suggestedModel: 'sonnet', confidence: 0.5, source: 'heuristic', latencyMs: 1, ...over };
}

function fixed(result: ClassifierResult | null): Classifier {
  return { classify: async () => result };
}

describe('makeRaceClassifier', () => {
  const deadline = AbortSignal.timeout(1000);

  it('prefers Haiku when its confidence clears the threshold', async () => {
    const rc = makeRaceClassifier({
      heuristic: fixed(res({ source: 'heuristic', suggestedModel: 'haiku', confidence: 0.8 })),
      haiku: fixed(res({ source: 'haiku', suggestedModel: 'opus', confidence: 0.7 })),
      cache: createClassifierCache(),
      haikuConfidenceThreshold: 0.6,
    });
    const r = await rc.classify(INPUT, deadline);
    expect(r?.source).toBe('haiku');
    expect(r?.suggestedModel).toBe('opus');
  });

  it('falls back to the heuristic when Haiku is below threshold', async () => {
    const rc = makeRaceClassifier({
      heuristic: fixed(res({ source: 'heuristic', suggestedModel: 'haiku', confidence: 0.5 })),
      haiku: fixed(res({ source: 'haiku', suggestedModel: 'opus', confidence: 0.4 })),
      cache: createClassifierCache(),
      haikuConfidenceThreshold: 0.6,
    });
    const r = await rc.classify(INPUT, deadline);
    expect(r?.source).toBe('heuristic');
  });

  it('uses the heuristic when Haiku returns null (timeout/failure)', async () => {
    const rc = makeRaceClassifier({
      heuristic: fixed(res({ source: 'heuristic', confidence: 0.5 })),
      haiku: fixed(null),
      cache: createClassifierCache(),
      haikuConfidenceThreshold: 0.6,
    });
    const r = await rc.classify(INPUT, deadline);
    expect(r?.source).toBe('heuristic');
  });

  it('caches the winner by requestHash so the second call skips classification', async () => {
    let haikuCalls = 0;
    const haiku: Classifier = {
      classify: async () => {
        haikuCalls += 1;
        return res({ source: 'haiku', confidence: 0.9 });
      },
    };
    const rc = makeRaceClassifier({
      heuristic: fixed(res({ confidence: 0.5 })),
      haiku,
      cache: createClassifierCache(),
      haikuConfidenceThreshold: 0.6,
    });
    await rc.classify(INPUT, deadline);
    await rc.classify(INPUT, deadline);
    expect(haikuCalls).toBe(1);
  });

  it('returns null when both classifiers return null', async () => {
    const rc = makeRaceClassifier({
      heuristic: fixed(null),
      haiku: fixed(null),
      cache: createClassifierCache(),
      haikuConfidenceThreshold: 0.6,
    });
    expect(await rc.classify(INPUT, deadline)).toBeNull();
  });
});
