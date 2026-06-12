// Classifier race orchestrator (§8.4 / section-12). Fires the deterministic
// heuristic and the Haiku classifier in parallel against a shared deadline.
// Haiku only wins when it returns a result whose confidence clears
// `confidenceThresholds.haiku`; otherwise the heuristic floor is used. Winners
// are cached by canonical request hash so retries don't re-call Haiku. The
// orchestrator NEVER throws and NEVER affects the upstream user request.

import type { Classifier, ClassifierInput, ClassifierResult } from './types.js';
import type { ClassifierConfig, PricingEntry } from '../config/schema.js';
import { HeuristicClassifier } from './heuristic.js';
import { createHaikuClassifier } from './haiku.js';
import { createClassifierCache, type ClassifierCache } from './cache.js';

export type { ClassifierCache } from './cache.js';

export interface RaceClassifierParts {
  readonly heuristic: Classifier;
  readonly haiku: Classifier;
  readonly cache: ClassifierCache;
  readonly haikuConfidenceThreshold: number;
}

// Lower-level constructor: takes the two classifiers and cache directly so the
// race resolution can be tested with fakes. `createRaceClassifier` wires the
// real implementations.
export function makeRaceClassifier(parts: RaceClassifierParts): Classifier {
  const { heuristic, haiku, cache, haikuConfidenceThreshold } = parts;
  return {
    async classify(input: ClassifierInput, deadline: AbortSignal): Promise<ClassifierResult | null> {
      const cached = cache.get(input.requestHash);
      if (cached !== undefined) return cached;

      const [heuristicResult, haikuResult] = await Promise.all([
        heuristic.classify(input, deadline),
        haiku.classify(input, deadline),
      ]);

      const winner: ClassifierResult | null =
        haikuResult !== null && haikuResult.confidence >= haikuConfidenceThreshold
          ? haikuResult
          : (heuristicResult ?? haikuResult);

      if (winner !== null) cache.set(input.requestHash, winner);
      return winner;
    },
  };
}

export interface RaceClassifierDeps {
  readonly config: ClassifierConfig;
  readonly pricing: Readonly<Record<string, PricingEntry>>;
}

export function createRaceClassifier(deps: RaceClassifierDeps): Classifier {
  return makeRaceClassifier({
    heuristic: new HeuristicClassifier(),
    haiku: createHaikuClassifier({ config: deps.config, pricing: deps.pricing }),
    cache: createClassifierCache(),
    haikuConfidenceThreshold: deps.config.confidenceThresholds.haiku,
  });
}
