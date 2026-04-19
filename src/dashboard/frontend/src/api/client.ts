import type { SummaryResponse, DecisionsResponse, CostsResponse } from './types.js';

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export function getSummary(): Promise<SummaryResponse> {
  return fetchJson<SummaryResponse>('/api/summary');
}

export function getDecisions(
  params: { limit?: number; since?: string; offset?: number } = {},
): Promise<DecisionsResponse> {
  const search = new URLSearchParams();
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.since !== undefined) search.set('since', params.since);
  if (params.offset !== undefined) search.set('offset', String(params.offset));
  const qs = search.toString();
  return fetchJson<DecisionsResponse>(`/api/decisions${qs ? '?' + qs : ''}`);
}

export function getCosts(
  params: { bucket?: 'hour' | 'day' } = {},
): Promise<CostsResponse> {
  const search = new URLSearchParams();
  if (params.bucket) search.set('bucket', params.bucket);
  const qs = search.toString();
  return fetchJson<CostsResponse>(`/api/costs${qs ? '?' + qs : ''}`);
}
