import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ConfigStore } from '../config/watcher.js';
import { readDecisions } from './read-log.js';
import { computeSummary, timeBuckets } from './aggregate.js';
import { getOrComputeMetrics } from './metrics.js';

export interface ApiOpts {
  readonly configStore: ConfigStore;
  readonly decisionLogDir: string;
}

const MAX_AGGREGATE_RECORDS = 100_000;
const VALID_GROUP_BY = new Set(['model', 'rule', 'hour']);

function parseSince(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return undefined;
  return d;
}

function defaultSince(): Date {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

function parsePaginatedQuery(query: Record<string, string>) {
  let limit = parseInt(query.limit ?? '100', 10);
  if (isNaN(limit) || limit < 1) limit = 100;
  if (limit > 1000) limit = 1000;

  let offset = parseInt(query.offset ?? '0', 10);
  if (isNaN(offset) || offset < 0) offset = 0;

  return { limit, offset };
}

function getDecisionsQueryError(query: Record<string, string>): string | null {
  if (query.since !== undefined) {
    const d = new Date(query.since);
    if (isNaN(d.getTime())) return 'invalid since parameter';
  }
  if (query.group_by !== undefined && !VALID_GROUP_BY.has(query.group_by)) {
    return 'invalid group_by value';
  }
  return null;
}

function groupDecisions(
  items: readonly { forwarded_model: string; policy_result: { rule_id?: string }; timestamp: string }[],
  groupBy: 'model' | 'rule' | 'hour',
): Record<string, number> {
  const groups: Record<string, number> = {};
  for (const item of items) {
    let key: string;
    if (groupBy === 'model') key = item.forwarded_model;
    else if (groupBy === 'rule') key = item.policy_result.rule_id ?? 'none';
    else key = new Date(item.timestamp).toISOString().slice(0, 13);
    groups[key] = (groups[key] ?? 0) + 1;
  }
  return groups;
}

function handleDecisions(decisionLogDir: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as Record<string, string>;
    const validationError = getDecisionsQueryError(query);
    if (validationError) return reply.code(400).send({ error: validationError });

    const { limit, offset } = parsePaginatedQuery(query);
    const since = query.since ? new Date(query.since) : undefined;
    const groupBy = query.group_by as 'model' | 'rule' | 'hour' | undefined;

    const result = await readDecisions(decisionLogDir, { ...(since !== undefined && { since }), limit, offset });

    if (groupBy) {
      const groups = groupDecisions(result.items, groupBy);
      return reply.send({ groups, limit, offset, total_scanned: result.totalScanned });
    }

    return reply.send({
      items: result.items,
      limit,
      offset,
      total_scanned: result.totalScanned,
    });
  };
}

function handleSummary(decisionLogDir: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as Record<string, string>;
    const since = parseSince(query.since) ?? defaultSince();

    const result = await readDecisions(decisionLogDir, {
      since,
      limit: MAX_AGGREGATE_RECORDS,
    });
    const summary = computeSummary(result.items);
    return reply.send({
      ...summary,
      truncated: result.totalScanned > MAX_AGGREGATE_RECORDS,
    });
  };
}

function handleCosts(decisionLogDir: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as Record<string, string>;
    const bucket = (query.bucket === 'day' ? 'day' : 'hour') as 'hour' | 'day';
    const since = parseSince(query.since) ?? defaultSince();

    const result = await readDecisions(decisionLogDir, {
      since,
      limit: MAX_AGGREGATE_RECORDS,
    });
    return reply.send({
      buckets: timeBuckets(result.items, bucket),
      truncated: result.totalScanned > MAX_AGGREGATE_RECORDS,
    });
  };
}

function handlePricing(configStore: ConfigStore) {
  return async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send(configStore.getCurrent().pricing);
  };
}

function handleMetrics(decisionLogDir: string) {
  return async (_req: FastifyRequest, reply: FastifyReply) => {
    const body = await getOrComputeMetrics(async () => {
      const since = new Date(Date.now() - 60 * 60 * 1000);
      const result = await readDecisions(decisionLogDir, {
        since,
        limit: MAX_AGGREGATE_RECORDS,
      });
      return result.items;
    });
    return reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(body);
  };
}

export function registerRoutes(
  server: FastifyInstance,
  opts: ApiOpts,
): void {
  const { configStore, decisionLogDir } = opts;

  server.get('/api/decisions', handleDecisions(decisionLogDir));
  server.get('/api/summary', handleSummary(decisionLogDir));
  server.get('/api/costs', handleCosts(decisionLogDir));
  server.get('/api/pricing', handlePricing(configStore));
  server.get('/metrics', handleMetrics(decisionLogDir));
}
