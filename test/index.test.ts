import { describe, it, expect, vi, afterEach } from 'vitest';
import { app, type Env } from '../src/index.js';
import { hashIp, dayStamp } from '../src/guard.js';
import { FakeKv, makeFakeGlobalBudgetNamespace, makeExecutionCtx } from './fakes.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sseResponse(body: unknown, status = 200): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

interface FakeEnvOptions {
  kv?: FakeKv;
  ipHashSalt?: string;
  rateLimiter?: { limit: (o: { key: string }) => Promise<{ success: boolean }> };
  globalBudget?: ReturnType<typeof makeFakeGlobalBudgetNamespace>;
  backendKey?: string;
  ipDayLimit?: string;
  globalDayLimit?: string;
}

function makeEnv(opts: FakeEnvOptions = {}): Env {
  const env: Record<string, unknown> = {
    FREE_TIER_BACKEND_KEY: opts.backendKey ?? 'ppn_live_test',
  };
  if (opts.kv) {
    env.FREE_KV = opts.kv;
    env.IP_HASH_SALT = opts.ipHashSalt ?? 'test-salt';
  }
  if (opts.rateLimiter) env.IP_RATE_LIMITER = opts.rateLimiter;
  if (opts.globalBudget) env.GLOBAL_BUDGET = opts.globalBudget;
  if (opts.ipDayLimit) env.FREE_IP_DAY_LIMIT = opts.ipDayLimit;
  if (opts.globalDayLimit) env.FREE_GLOBAL_DAY_LIMIT = opts.globalDayLimit;
  return env;
}

async function postMcp(env: Env, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const { ctx, flush } = makeExecutionCtx();
  const res = await app.request(
    '/mcp',
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
    env,
    ctx,
  );
  await flush();
  return res;
}

const rpc = (method: string, params?: unknown, id: number | null = 1) => ({ jsonrpc: '2.0', id, method, params });
const toolCall = (name: string, args: Record<string, unknown> = {}, id = 1) => rpc('tools/call', { name, arguments: args }, id);

describe('POST /mcp — protocol-level rejection (no budgets/KV involved)', () => {
  it('rejects a batch with -32600 (400)', async () => {
    const res = await postMcp(makeEnv(), [toolCall('search_apis'), toolCall('search_apis')]);
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: number } }>();
    expect(body.error.code).toBe(-32600);
  });

  it('rejects an unknown method with -32601 (200)', async () => {
    const res = await postMcp(makeEnv(), rpc('shutdown'));
    expect(res.status).toBe(200);
    const body = await res.json<{ error: { code: number } }>();
    expect(body.error.code).toBe(-32601);
  });

  it('rejects jsonrpc !== "2.0" with -32600 (400)', async () => {
    const res = await postMcp(makeEnv(), { jsonrpc: '1.0', id: 1, method: 'initialize' });
    expect(res.status).toBe(400);
  });

  it('rejects unparseable JSON with -32700 (400)', async () => {
    const { ctx } = makeExecutionCtx();
    const res = await app.request(
      '/mcp',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' },
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: number } }>();
    expect(body.error.code).toBe(-32700);
  });
});

describe('POST /mcp — anonymous methods and key injection', () => {
  it('forwards initialize without an Authorization header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }));
    const res = await postMcp(makeEnv(), rpc('initialize', {}));
    expect(res.status).toBe(200);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('never forwards the client-supplied Authorization header (anonymous-only endpoint)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }));
    await postMcp(makeEnv(), toolCall('search_apis', { query: 'weather' }), {
      authorization: 'Bearer client-supplied-key',
    });
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('injects the backend key for an allowlisted execute_api call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }));
    const res = await postMcp(
      makeEnv({ backendKey: 'ppn_live_abc123' }), // gitleaks:allow — test dummy, not a real key
      toolCall('execute_api', { api: 'onokoro', operationId: 'getElevation' }),
    );
    expect(res.status).toBe(200);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ppn_live_abc123');
  });

  it('denies a non-allowlisted execute_api call without ever calling upstream', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await postMcp(makeEnv(), toolCall('execute_api', { api: 'onokoro', operationId: 'postFeedback' }));
    expect(res.status).toBe(200);
    const body = await res.json<{ result: { isError: boolean } }>();
    expect(body.result.isError).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 503 FREE_TIER_UNAVAILABLE when needsKey but no backend key is configured, without spending any budget', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const kv = new FakeKv();
    const ns = makeFakeGlobalBudgetNamespace();
    const ip = '203.0.113.40';
    const salt = 'test-salt';
    const ipHash = await hashIp(ip, salt);
    const day = dayStamp(new Date());

    const env = makeEnv({ kv, ipHashSalt: salt, globalBudget: ns });
    env.FREE_TIER_BACKEND_KEY = undefined;
    const res = await postMcp(env, toolCall('execute_api', { api: 'onokoro', operationId: 'getElevation' }), {
      'cf-connecting-ip': ip,
    });

    expect(res.status).toBe(503);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('FREE_TIER_UNAVAILABLE');
    // The 503 fires before any budget is touched — this must not have called
    // upstream or charged either the per-IP (KV) or global (DO) counter.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(kv.store.has(`free-day:${ipHash}:${day}`)).toBe(false);
    expect(await ns.storage.get<number>(`used:${day}`)).toBeUndefined();
  });

  it('patches tools/list descriptions (plain JSON)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [{ name: 'execute_api', description: 'Execute an API.' }] },
      }),
    );
    const res = await postMcp(makeEnv(), rpc('tools/list'));
    const body = await res.json<{ result: { tools: { description: string }[] } }>();
    expect(body.result.tools[0]?.description).toContain('Free tier');
  });

  it('patches tools/list descriptions (SSE)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [{ name: 'environment_brief', description: 'Brief for a location.' }] },
      }),
    );
    const res = await postMcp(makeEnv(), rpc('tools/list'));
    const text = await res.text();
    expect(text).toContain('Free tier');
    expect(text.startsWith('event: message')).toBe(true);
  });
});

describe('POST /mcp — ban list and rate limiting', () => {
  it('blocks a banned IP with 429 before inspecting the body', async () => {
    const kv = new FakeKv();
    const ip = '203.0.113.5';
    const salt = 'test-salt';
    const ipHash = await hashIp(ip, salt);
    kv.store.set(`free-ban:${ipHash}`, '1');
    const res = await postMcp(makeEnv({ kv, ipHashSalt: salt }), rpc('initialize'), { 'cf-connecting-ip': ip });
    expect(res.status).toBe(429);
  });

  it('blocks when the per-minute rate limiter rejects', async () => {
    const res = await postMcp(
      makeEnv({ rateLimiter: { limit: () => Promise.resolve({ success: false }) } }),
      rpc('initialize'),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
  });

  it('does not block when the rate limiter allows', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }));
    const res = await postMcp(
      makeEnv({ rateLimiter: { limit: () => Promise.resolve({ success: true }) } }),
      rpc('initialize'),
    );
    expect(res.status).toBe(200);
  });
});

describe('POST /mcp — misconfiguration fails closed', () => {
  it('returns 503 FREE_TIER_MISCONFIGURED when KV is bound but IP_HASH_SALT is missing', async () => {
    const kv = new FakeKv();
    const env = makeEnv({ kv });
    env.IP_HASH_SALT = undefined;
    const res = await postMcp(env, rpc('initialize'));
    expect(res.status).toBe(503);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('FREE_TIER_MISCONFIGURED');
  });

  it('does not require IP_HASH_SALT when KV is not bound (local dev)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }));
    const res = await postMcp(makeEnv(), rpc('initialize'));
    expect(res.status).toBe(200);
  });
});

describe('POST /mcp — daily budgets', () => {
  it('charges both the per-IP (KV) and global (DO) counters on a normal call', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }));
    const kv = new FakeKv();
    const ns = makeFakeGlobalBudgetNamespace();
    const ip = '203.0.113.9';
    const salt = 'test-salt';
    const ipHash = await hashIp(ip, salt);
    const day = dayStamp(new Date());

    const res = await postMcp(makeEnv({ kv, ipHashSalt: salt, globalBudget: ns }), toolCall('search_apis', { query: 'x' }), {
      'cf-connecting-ip': ip,
    });

    expect(res.status).toBe(200);
    expect(kv.store.get(`free-day:${ipHash}:${day}`)).toBe('1');
    expect(await ns.storage.get<number>(`used:${day}`)).toBe(1);
  });

  it('rejects with 429 when the per-IP daily budget is exhausted, without touching the global budget', async () => {
    const kv = new FakeKv();
    const ns = makeFakeGlobalBudgetNamespace();
    const ip = '203.0.113.10';
    const salt = 'test-salt';
    const ipHash = await hashIp(ip, salt);
    const day = dayStamp(new Date());
    kv.store.set(`free-day:${ipHash}:${day}`, '1');

    const res = await postMcp(
      makeEnv({ kv, ipHashSalt: salt, globalBudget: ns, ipDayLimit: '1' }),
      toolCall('search_apis', { query: 'x' }),
      { 'cf-connecting-ip': ip },
    );

    expect(res.status).toBe(429);
    expect(await ns.storage.get<number>(`used:${day}`)).toBeUndefined();
  });

  it('rejects with 429 when the global daily budget is exhausted, without charging the per-IP counter', async () => {
    const kv = new FakeKv();
    const ns = makeFakeGlobalBudgetNamespace();
    const ip = '203.0.113.11';
    const salt = 'test-salt';
    const ipHash = await hashIp(ip, salt);
    const day = dayStamp(new Date());
    await ns.storage.put(`used:${day}`, 2);

    const res = await postMcp(
      makeEnv({ kv, ipHashSalt: salt, globalBudget: ns, globalDayLimit: '2' }),
      toolCall('search_apis', { query: 'x' }),
      { 'cf-connecting-ip': ip },
    );

    expect(res.status).toBe(429);
    expect(kv.store.has(`free-day:${ipHash}:${day}`)).toBe(false);
  });

  it('enforces the per-IP budget when only KV is bound (no GLOBAL_BUDGET)', async () => {
    const kv = new FakeKv();
    const ip = '203.0.113.12';
    const salt = 'test-salt';
    const ipHash = await hashIp(ip, salt);
    const day = dayStamp(new Date());
    kv.store.set(`free-day:${ipHash}:${day}`, '1');

    const res = await postMcp(
      makeEnv({ kv, ipHashSalt: salt, ipDayLimit: '1' }), // no globalBudget
      toolCall('search_apis', { query: 'x' }),
      { 'cf-connecting-ip': ip },
    );

    expect(res.status).toBe(429);
  });

  it('enforces the global budget when only GLOBAL_BUDGET is bound (no FREE_KV) — regression for the KV-gated bug', async () => {
    const ns = makeFakeGlobalBudgetNamespace();
    const day = dayStamp(new Date());
    await ns.storage.put(`used:${day}`, 2);

    const res = await postMcp(
      makeEnv({ globalBudget: ns, globalDayLimit: '2' }), // no kv at all
      toolCall('search_apis', { query: 'x' }),
    );

    expect(res.status).toBe(429);
    // The global counter must not have been charged past the limit either.
    expect(await ns.storage.get<number>(`used:${day}`)).toBe(2);
  });

  it('charges the global budget on a normal call when only GLOBAL_BUDGET is bound (no FREE_KV)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }));
    const ns = makeFakeGlobalBudgetNamespace();
    const day = dayStamp(new Date());

    const res = await postMcp(makeEnv({ globalBudget: ns }), toolCall('search_apis', { query: 'x' })); // no kv

    expect(res.status).toBe(200);
    expect(await ns.storage.get<number>(`used:${day}`)).toBe(1);
  });
});

describe('POST /mcp — upstream failure handling', () => {
  it('returns 502 UPSTREAM_UNAVAILABLE and refunds both counters when fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const kv = new FakeKv();
    const ns = makeFakeGlobalBudgetNamespace();
    const ip = '203.0.113.20';
    const salt = 'test-salt';
    const ipHash = await hashIp(ip, salt);
    const day = dayStamp(new Date());

    const res = await postMcp(makeEnv({ kv, ipHashSalt: salt, globalBudget: ns }), toolCall('search_apis', { query: 'x' }), {
      'cf-connecting-ip': ip,
    });

    expect(res.status).toBe(502);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(kv.store.get(`free-day:${ipHash}:${day}`)).toBe('0');
    expect(await ns.storage.get<number>(`used:${day}`)).toBe(0);
  });

  it('passes through a 5xx upstream response and refunds both counters', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'boom' }, 503));
    const kv = new FakeKv();
    const ns = makeFakeGlobalBudgetNamespace();
    const ip = '203.0.113.21';
    const salt = 'test-salt';
    const ipHash = await hashIp(ip, salt);
    const day = dayStamp(new Date());

    const res = await postMcp(makeEnv({ kv, ipHashSalt: salt, globalBudget: ns }), toolCall('search_apis', { query: 'x' }), {
      'cf-connecting-ip': ip,
    });

    expect(res.status).toBe(503);
    expect(kv.store.get(`free-day:${ipHash}:${day}`)).toBe('0');
    expect(await ns.storage.get<number>(`used:${day}`)).toBe(0);
  });

  it('passes through a 4xx upstream response WITHOUT refunding', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'nope' }, 404));
    const kv = new FakeKv();
    const ns = makeFakeGlobalBudgetNamespace();
    const ip = '203.0.113.22';
    const salt = 'test-salt';
    const ipHash = await hashIp(ip, salt);
    const day = dayStamp(new Date());

    const res = await postMcp(makeEnv({ kv, ipHashSalt: salt, globalBudget: ns }), toolCall('search_apis', { query: 'x' }), {
      'cf-connecting-ip': ip,
    });

    expect(res.status).toBe(404);
    expect(kv.store.get(`free-day:${ipHash}:${day}`)).toBe('1');
    expect(await ns.storage.get<number>(`used:${day}`)).toBe(1);
  });
});

describe('GET / and misc routes', () => {
  it('describes the free tier on the landing route', async () => {
    const res = await app.request('/', {}, makeEnv());
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { endpoint: string; tools: string[] } }>();
    expect(body.data.endpoint).toBe('/mcp');
    expect(body.data.tools).toContain('execute_api');
  });

  it('reports healthy on /health', async () => {
    const res = await app.request('/health', {}, makeEnv());
    expect(res.status).toBe(200);
  });

  it('rejects non-POST /mcp with 405', async () => {
    const res = await app.request('/mcp', { method: 'GET' }, makeEnv());
    expect(res.status).toBe(405);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('METHOD_NOT_ALLOWED');
  });
});

describe('POST /mcp — additional guard branches', () => {
  it('fails open when the rate limiter throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }));
    const res = await postMcp(
      makeEnv({ rateLimiter: { limit: () => Promise.reject(new Error('limiter down')) } }),
      rpc('initialize'),
    );
    expect(res.status).toBe(200);
  });

  it('records the denial and API spread (KV) when a tools/call is denied', async () => {
    const kv = new FakeKv();
    const ip = '203.0.113.30';
    const salt = 'test-salt';
    const ipHash = await hashIp(ip, salt);
    const res = await postMcp(
      makeEnv({ kv, ipHashSalt: salt }),
      toolCall('execute_api', { api: 'onokoro', operationId: 'postFeedback' }),
      { 'cf-connecting-ip': ip },
    );
    expect(res.status).toBe(200);
    expect(kv.store.get(`free-err:${ipHash}`)).toBe('1');
    expect(JSON.parse(kv.store.get(`free-enum:${ipHash}`) ?? '[]')).toEqual(['onokoro']);
  });

  it('records API spread (KV) on a successful allowlisted execute_api call', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }));
    const kv = new FakeKv();
    const ip = '203.0.113.31';
    const salt = 'test-salt';
    const ipHash = await hashIp(ip, salt);
    const res = await postMcp(
      makeEnv({ kv, ipHashSalt: salt }),
      toolCall('execute_api', { api: 'onokoro', operationId: 'getElevation' }),
      { 'cf-connecting-ip': ip },
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(kv.store.get(`free-enum:${ipHash}`) ?? '[]')).toEqual(['onokoro']);
  });
});
