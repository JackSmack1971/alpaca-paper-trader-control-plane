import { ALPACA_PAPER_BASE_URL } from '../domain/paper.js';
import { SimulatedProviderFailure, type SimulatedAccountResource } from '../domain/local-test-harness.js';

const resources = new Map<string, SimulatedAccountResource>([
  ['/v2/account', 'account'],
  ['/v2/positions', 'positions'],
  ['/v2/orders?status=open&limit=500', 'orders'],
  ['/v2/clock', 'clock'],
]);

export type LocalAccountResourceReader = (resource: SimulatedAccountResource) => unknown | Promise<unknown>;
export type LocalAccountRequestObserver = (resource: SimulatedAccountResource) => void;

/** In-memory transport for the fixed PAPER account client. It never delegates to global fetch. */
export function createLocalAlpacaAccountFetch(
  readResource: LocalAccountResourceReader,
  observeRequest: LocalAccountRequestObserver = () => undefined,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input);
    if (url.origin !== ALPACA_PAPER_BASE_URL || url.username || url.password || url.hash || init?.method !== 'GET') {
      throw new TypeError('unsupported simulated PAPER request');
    }
    const resource = resources.get(`${url.pathname}${url.search}`);
    if (!resource) throw new TypeError('unsupported simulated PAPER request');

    observeRequest(resource);
    try {
      const response = await readResource(resource);
      const data = response && typeof response === 'object' && 'data' in response ? response.data : response;
      return Response.json(data);
    } catch (error) {
      if (!(error instanceof SimulatedProviderFailure)) throw new TypeError('simulated provider transport failed');
      if (error.statusCode === 503) throw new TypeError('simulated network failure');
      if (error.statusCode === 429) return new Response('{}', { status: error.statusCode, headers: { 'retry-after': '7' } });
      return new Response('{}', { status: error.statusCode });
    }
  }) as typeof fetch;
}
