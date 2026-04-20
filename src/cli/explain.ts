import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pino from 'pino';
import { loadConfig } from '../config/loader.js';
import { resolvePaths } from '../config/paths.js';
import { loadRules } from '../policy/load.js';
import { evaluate } from '../policy/evaluate.js';
import { extractSignals } from '../signals/extract.js';
import { HeuristicClassifier } from '../classifier/heuristic.js';
import type { Signals, SessionContext } from '../signals/types.js';
import type { PolicyResult } from '../policy/dsl.js';
import type { ClassifierResult } from '../classifier/types.js';
import type { LoadedConfig } from '../config/loader.js';

export interface ExplainOptions {
  readonly requestPath: string;
  readonly configPath?: string;
  readonly classifier: boolean;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

function stubSession(): SessionContext {
  return { createdAt: Date.now(), retrySeen: () => 0 };
}

function renderChoice(result: PolicyResult): string {
  if (result.kind === 'abstain') return 'abstain';
  const r = result.result;
  if ('choice' in r) {
    return typeof r.choice === 'string' ? r.choice : r.choice.modelId;
  }
  if ('escalate' in r) return `escalate(${r.escalate})`;
  return 'unknown';
}

function renderSignalTable(s: Signals): string {
  const pad = 26;
  const lines: [string, string][] = [
    ['plan_mode', String(s.planMode)],
    ['message_count', String(s.messageCount)],
    ['tool_count', String(s.toolUseCount)],
    ['tools', s.tools.length > 0 ? `[${[...s.tools].join(', ')}]` : '[]'],
    ['token_estimate', String(s.estInputTokens)],
    ['file_ref_count', String(s.fileRefCount)],
    ['retry_count', String(s.retryCount)],
    ['frustration', String(s.frustration)],
    ['explicit_model', String(s.explicitModel)],
    ['project_path', String(s.projectPath)],
    ['session_duration_ms', String(s.sessionDurationMs)],
    ['beta_flags', s.betaFlags.length > 0 ? `[${[...s.betaFlags].join(', ')}]` : '[]'],
    ['session_id', s.sessionId],
    ['request_hash', s.requestHash],
  ];
  return lines.map(([k, v]) => `${k.padEnd(pad)}${v}`).join('\n');
}

function renderPolicy(policy: PolicyResult, ruleCount: number): string {
  const lines: string[] = [];
  lines.push(`Evaluated rules: ${ruleCount}`);
  if (policy.kind === 'matched') {
    lines.push(`Winning rule:    id="${policy.ruleId}"  ->  ${renderChoice(policy)}`);
  } else {
    lines.push('Winning rule:    abstain');
  }
  return lines.join('\n');
}

function renderClassifier(
  policy: PolicyResult,
  useClassifier: boolean,
  result: ClassifierResult | null,
): string {
  if (!useClassifier) return '(not requested)';
  if (policy.kind === 'matched') return '(not invoked — policy matched)';
  if (!result) return 'classifier not available';
  return `${result.suggestedModel} (score=${result.score.toFixed(1)}, confidence=${result.confidence.toFixed(2)}, source=${result.source})`;
}

function renderFinal(
  policy: PolicyResult,
  useClassifier: boolean,
  classifierResult: ClassifierResult | null,
): string {
  if (policy.kind === 'matched') {
    return `${renderChoice(policy)} via rule "${policy.ruleId}"`;
  }
  if (useClassifier && classifierResult) {
    return `${classifierResult.suggestedModel} via classifier (heuristic)`;
  }
  return 'abstain (no classifier requested)';
}

interface LoadedInputs {
  readonly absPath: string;
  readonly configFile: string;
  readonly config: LoadedConfig;
  readonly body: unknown;
}

async function loadInputs(
  opts: ExplainOptions,
): Promise<{ ok: true; value: LoadedInputs } | { ok: false; code: number }> {
  const absPath = resolve(opts.requestPath);
  const configFile = opts.configPath ?? resolvePaths().configFile;

  const configResult = await loadConfig(configFile);
  if (!configResult.ok) {
    for (const e of configResult.error) {
      opts.stderr.write(`config error [${e.path}]: ${e.message}\n`);
    }
    return { ok: false, code: 1 };
  }

  let rawJson: string;
  try {
    rawJson = readFileSync(absPath, 'utf8');
  } catch {
    opts.stderr.write(`Cannot read request file: ${absPath}\n`);
    return { ok: false, code: 1 };
  }

  let body: unknown;
  try {
    body = JSON.parse(rawJson);
  } catch {
    opts.stderr.write(`Invalid JSON in ${absPath}\n`);
    return { ok: false, code: 1 };
  }

  return { ok: true, value: { absPath, configFile, config: configResult.value, body } };
}

function formatReport(
  absPath: string,
  configFile: string,
  mode: string,
  signals: Signals,
  policy: PolicyResult,
  ruleCount: number,
  useClassifier: boolean,
  classifierResult: ClassifierResult | null,
): string {
  return [
    `Request:          ${absPath}`,
    `Config:           ${configFile}`,
    `Mode:             ${mode}`,
    '',
    'Signals',
    '-------',
    renderSignalTable(signals),
    '',
    'Policy',
    '------',
    renderPolicy(policy, ruleCount),
    '',
    'Classifier',
    '----------',
    renderClassifier(policy, useClassifier, classifierResult),
    '',
    `Final decision:  ${renderFinal(policy, useClassifier, classifierResult)}`,
    '',
  ].join('\n');
}

export async function runExplain(opts: ExplainOptions): Promise<number> {
  const loaded = await loadInputs(opts);
  if (!loaded.ok) return loaded.code;

  const { absPath, configFile, body } = loaded.value;
  const { config } = loaded.value.config;

  const logger = pino({ level: 'silent' });
  const signals = extractSignals(body, undefined, stubSession(), logger);

  const rawRules = config.rules.map((r) => {
    const then = r.allowDowngrade !== undefined ? { ...r.then, allowDowngrade: r.allowDowngrade } : r.then;
    return { id: r.id, when: r.when, then };
  });
  const rulesResult = loadRules(rawRules, { modelTiers: config.modelTiers });
  if (!rulesResult.ok) {
    for (const e of rulesResult.error) {
      opts.stderr.write(`rule error [${e.path}]: ${e.message}\n`);
    }
    return 1;
  }
  const rules = rulesResult.value;
  const policy = evaluate(rules, signals);

  let classifierResult: ClassifierResult | null = null;
  if (opts.classifier && policy.kind === 'abstain') {
    const heuristic = new HeuristicClassifier();
    classifierResult = await heuristic.classify(
      { signals, body, requestHash: signals.requestHash },
      AbortSignal.timeout(5000),
    );
  }

  opts.stdout.write(formatReport(
    absPath, configFile, config.mode, signals, policy, rules.length, opts.classifier, classifierResult,
  ));
  return 0;
}
