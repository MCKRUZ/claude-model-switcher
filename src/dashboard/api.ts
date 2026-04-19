import type { FastifyInstance } from 'fastify';
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
  if (isNaN(d.getTime())) return null as unknown as undefined;
  return d;
}

export function registerRoutes(
  server: FastifyInstance,
  opts: ApiOpts,
): void {
  const { configStore, decisionLogDir } = opts;

  server.get('/api/decisions', async (req, reply) => {
    const query = req.query as Record<string, string>;
    let limit = parseInt(query.limit ?? '100', 10);
    if (isNaN(limit) || limit < 1) limit = 100;
    if (limit > 1000) limit = 1000;

    let offset = parseInt(query.offset ?? '0', 10);
    if (isNaN(offset) || offset < 0) offset = 0;

    if (query.since !== undefined) {
      const d = new Date(query.since);
      if (isNaN(d.getTime())) {
        return reply.code(400).send({ error: 'invalid since parameter' });
      }
    }
    const since = query.since ? new Date(query.since) : undefined;

    if (query.group_by !== undefined && !VALID_GROUP_BY.has(query.group_by)) {
      return reply.code(400).send({ error: 'invalid group_by value' });
    }
    const groupBy = query.group_by as 'model' | 'rule' | 'hour' | undefined;

    const result = await readDecisions(decisionLogDir, { since, limit, offset });

    if (groupBy) {
      const groups: Record<string, number> = {};
      for (const item of result.items) {
        let key: string;
        if (groupBy === 'model') key = item.forwarded_model;
        else if (groupBy === 'rule') key = item.policy_result.rule_id ?? 'none';
        else key = new Date(item.timestamp).toISOString().slice(0, 13);
        groups[key] = (groups[key] ?? 0) + 1;
      }
      return reply.send({ groups, limit, offset, total_scanned: result.totalScanned });
    }

    return reply.send({
      items: result.items,
      limit,
      offset,
      total_scanned: result.totalScanned,
    });
  });

  server.get('/api/summary', async (req, reply) => {
    const query = req.query as Record<string, string>;
    const since = parseSince(query.since)
      ?? new Date(Date.now() - 24 * 60 * 60 * 1000);

    const result = await readDecisions(decisionLogDir, {
      since,
      limit: MAX_AGGREGATE_RECORDS,
    });
    const summary = computeSummary(result.items);
    return reply.send({
      ...summary,
      truncated: result.totalScanned > MAX_AGGREGATE_RECORDS,
    });
  });

  server.get('/api/costs', async (req, reply) => {
    const query = req.query as Record<string, string>;
    const bucket = (query.bucket === 'day' ? 'day' : 'hour') as 'hour' | 'day';
    const since = parseSince(query.since)
      ?? new Date(Date.now() - 24 * 60 * 60 * 1000);

    const result = await readDecisions(decisionLogDir, {
      since,
      limit: MAX_AGGREGATE_RECORDS,
    });
    return reply.send({
      buckets: timeBuckets(result.items, bucket),
      truncated: result.totalScanned > MAX_AGGREGATE_RECORDS,
    });
  });

  server.get('/api/pricing', async (_req, reply) => {
    return reply.send(configStore.getCurrent().pricing);
  });

  server.get('/metrics', async (_req, reply) => {
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
  });
}
